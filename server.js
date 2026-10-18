import express from 'express';
import cors from 'cors';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

// Estado global da conexão
let sock = null;
let currentQR = null;
let isConnected = false;
let userProfile = null;

// ================= SISTEMA DE LOGS ================= //
// Armazena as últimas 50 consultas em memória para exibição em tempo real
const queryLogs = [];
const MAX_LOGS = 50;

function addLog(number, status, details = '') {
    const timestamp = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const logEntry = {
        time: timestamp,
        number,
        status, // 'COM FOTO', 'SEM FOTO', 'NÃO CADASTRADO', 'ERRO'
        details
    };
    
    // Adiciona no início da lista
    queryLogs.unshift(logEntry);
    if (queryLogs.length > MAX_LOGS) {
        queryLogs.pop();
    }

    // Imprime também no terminal/Render
    console.log(`[LOG ${timestamp}] Número: ${number} | Status: ${status} ${details ? `(${details})` : ''}`);
}
// ==================================================== //

// ================= ANTI-BAN / PROTEÇÃO ================= //
// 1. Cache em Memória RAM (sem banco de dados)
// Guarda o resultado por 24 horas. Não consulta o WhatsApp se já tiver no cache.
const memoryCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function getCached(number) {
    const item = memoryCache.get(number);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        memoryCache.delete(number);
        return null;
    }
    return item.data;
}

function setCache(number, data) {
    // Limita o tamanho do cache em memória para não consumir muita RAM (max 10.000 itens)
    if (memoryCache.size > 10000) {
        const firstKey = memoryCache.keys().next().value;
        memoryCache.delete(firstKey);
    }
    memoryCache.set(number, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

// 2. Fila sequencial com Delay Humano com Jitter (Anti-Spam / Anti-Ban Avançado)
let requestQueue = Promise.resolve();
let consecutiveErrors = 0;
let circuitBreakerPauseUntil = 0;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueWhatsAppTask(taskFn) {
    const currentTask = requestQueue.then(async () => {
        // Se a Meta começou a rejeitar requisições recentemente, pausa automática por 5 minutos
        if (Date.now() < circuitBreakerPauseUntil) {
            const waitSeconds = Math.ceil((circuitBreakerPauseUntil - Date.now()) / 1000);
            throw new Error(`Proteção anti-ban ativa: Muitas requisições recentes. Pausa temporária por mais ${waitSeconds}s.`);
        }

        // Delay aleatório com variação humana (1.8s a 4.2s)
        const randomDelay = Math.floor(Math.random() * (4200 - 1800 + 1)) + 1800;
        await delay(randomDelay);

        try {
            const result = await taskFn();
            consecutiveErrors = 0; // Sucesso, zera contador de erros
            return result;
        } catch (err) {
            consecutiveErrors++;
            // Se der 5 erros seguidos da Meta (ex: rate limit ou bloqueio), pausa o robô por 5 minutos
            if (consecutiveErrors >= 5) {
                circuitBreakerPauseUntil = Date.now() + (5 * 60 * 1000);
                console.warn('⚠️ [ANTI-BAN] 5 falhas seguidas detectadas. Circuito pausado por 5 minutos para proteger o chip.');
            }
            throw err;
        }
    });

    // Mantém a fila fluindo mesmo com erros
    requestQueue = currentTask.catch(() => {});
    return currentTask;
}
// ======================================================== //

// Inicializa a conexão com o WhatsApp
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        let version;
        try {
            const versionData = await fetchLatestBaileysVersion();
            version = versionData.version;
        } catch (vErr) {
            console.warn('Não foi possível buscar a versão mais recente do Baileys, usando padrão:', vErr.message);
        }

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'info' }),
            printQRInTerminal: true,
            // Simulação autêntica de navegador Desktop
            browser: ['Mac OS', 'Chrome', '125.0.0.0'],
            // Mantém ping ativo para a conexão não cair por inatividade
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            markOnlineOnConnect: false, // Ficar "invisível" para não chamar atenção nos servidores
            syncFullHistory: false // Não baixa conversas desnecessárias economizando banda e telemetria
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQR = qr;
                isConnected = false;
                console.log('\n=============================================');
                console.log('📌 QR CODE GERADO NO RENDER! Escaneie pelo WhatsApp:');
                console.log('=============================================\n');
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                isConnected = false;
                userProfile = null;
                currentQR = null;

                console.log(`⚠️ Conexão fechada (Código: ${statusCode}). Desconectado/LoggedOut: ${isLoggedOut}`);

                if (isLoggedOut) {
                    console.log('🧹 Limpando arquivos de sessão antigos para forçar novo QR Code...');
                    try {
                        import('fs').then(fs => {
                            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                            console.log('✅ Pasta auth_info_baileys limpa com sucesso!');
                        });
                    } catch (e) {
                        console.error('Erro ao limpar pasta de auth:', e);
                    }
                    setTimeout(connectToWhatsApp, 2000);
                } else {
                    console.log('Tentando reconectar em 3 segundos...');
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQR = null;
                userProfile = sock.user;
                console.log('\n=============================================');
                console.log(`✅ WhatsApp CONECTADO com sucesso no Render!`);
                console.log(`📱 Número conectado: ${sock.user?.id?.split(':')[0] || 'Desconhecido'}`);
                console.log('=============================================\n');
            }
        });
    } catch (err) {
        console.error('Erro ao conectar ao WhatsApp:', err);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// ------------------- ROTAS DA API ------------------- //

// Rota de status do serviço
app.get('/status', (req, res) => {
    res.json({
        online: isConnected,
        message: isConnected ? 'WhatsApp conectado e pronto para consultas.' : 'Aguardando autenticação por QR Code.',
        user: userProfile ? { id: userProfile.id.split(':')[0], name: userProfile.name } : null,
        totalLogs: queryLogs.length
    });
});

// Painel Visual de Logs em Tempo Real
app.get('/logs', (req, res) => {
    const logRows = queryLogs.length === 0 
        ? `<tr><td colspan="4" style="text-align:center; padding: 20px; color: #777;">Nenhuma consulta realizada ainda.</td></tr>`
        : queryLogs.map(log => {
            let badgeBg = '#2e7d32'; // verde
            if (log.status === 'SEM FOTO') badgeBg = '#f57c00'; // laranja
            if (log.status === 'NÃO CADASTRADO') badgeBg = '#c2185b'; // rosa escuro
            if (log.status === 'ERRO') badgeBg = '#d32f2f'; // vermelho

            return `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 10px; font-family: monospace; color: #555;">${log.time}</td>
                    <td style="padding: 10px; font-weight: bold; font-family: monospace;">${log.number}</td>
                    <td style="padding: 10px;">
                        <span style="background: ${badgeBg}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 500;">
                            ${log.status}
                        </span>
                    </td>
                    <td style="padding: 10px; color: #666; font-size: 13px;">${log.details || '-'}</td>
                </tr>
            `;
        }).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>API Zap - Logs em Tempo Real</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 25px; }
                .container { max-width: 850px; margin: 0 auto; background: white; border-radius: 8px; padding: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #eef2f5; padding-bottom: 15px; margin-bottom: 20px; }
                h1 { margin: 0; font-size: 22px; color: #111; }
                .status-badge { padding: 5px 12px; border-radius: 20px; font-size: 13px; font-weight: bold; }
                .online { background: #e8f5e9; color: #2e7d32; }
                .offline { background: #ffebee; color: #c62828; }
                table { width: 100%; border-collapse: collapse; text-align: left; }
                th { background: #fafbfc; padding: 12px 10px; border-bottom: 2px solid #eaedf0; font-size: 13px; color: #444; }
                .refresh-note { font-size: 12px; color: #888; text-align: right; margin-top: 15px; }
            </style>
            <script>setTimeout(() => location.reload(), 4000);</script>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div>
                        <h1>📊 Logs de Consultas</h1>
                        <p style="margin: 4px 0 0 0; color: #666; font-size: 13px;">Últimas 50 consultas da API (Atualiza a cada 4s)</p>
                    </div>
                    <span class="status-badge ${isConnected ? 'online' : 'offline'}">
                        ${isConnected ? '● WhatsApp Conectado' : '○ Desconectado'}
                    </span>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th width="15%">Hora</th>
                            <th width="30%">Número</th>
                            <th width="25%">Resultado</th>
                            <th width="30%">Origem / Detalhes</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${logRows}
                    </tbody>
                </table>
                <div class="refresh-note">Página atualizada automaticamente em tempo real • <a href="/status" style="color: #075e54;">JSON Status</a></div>
            </div>
        </body>
        </html>
    `);
});

// Rota para obter logs em formato JSON (caso queira consumir por API)
app.get('/api/logs', (req, res) => {
    res.json(queryLogs);
});

// Rota visual para escanear o QR Code no navegador
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #2e7d32;">✅ WhatsApp Conectado!</h1>
                <p>O serviço já está autenticado e pronto para uso.</p>
                <a href="/status">Ver status da API</a>
            </div>
        `);
    }

    if (!currentQR) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h2>⏳ Gerando QR Code...</h2>
                <p>Aguarde alguns segundos e recarregue a página.</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </div>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 40px;">
                <h1 style="color: #075e54;">Conectar API ao WhatsApp</h1>
                <p>Abra o WhatsApp no celular > Aparelhos conectados > Conectar um aparelho</p>
                <img src="${qrImage}" style="border: 2px solid #ccc; border-radius: 8px; margin: 20px 0;" />
                <p style="color: #666; font-size: 14px;">A página atualiza automaticamente a cada 15 segundos.</p>
                <script>setTimeout(() => location.reload(), 15000);</script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Erro ao renderizar o QR Code');
    }
});

// Endpoint principal: Puxar a foto de perfil do número
app.get('/api/avatar', async (req, res) => {
    let { number } = req.query;

    if (!number) {
        return res.status(400).json({ 
            error: 'O parâmetro "number" é obrigatório. Exemplo: /api/avatar?number=5511999999999' 
        });
    }

    // Remove qualquer caractere que não seja dígito
    const cleanNumber = number.toString().replace(/\D/g, '');

    if (cleanNumber.length < 8) {
        return res.status(400).json({ error: 'Número de telefone inválido.' });
    }

    // 1. CHECA NO CACHE EM MEMÓRIA (Sem banco de dados e sem chamar o WhatsApp)
    const cached = getCached(cleanNumber);
    if (cached) {
        addLog(cleanNumber, cached.hasProfilePic ? 'COM FOTO' : (cached.exists ? 'SEM FOTO' : 'NÃO CADASTRADO'), 'Cache');
        return res.json({
            ...cached,
            fromCache: true
        });
    }

    if (!isConnected || !sock) {
        addLog(cleanNumber, 'ERRO', 'WhatsApp desconectado');
        return res.status(503).json({ 
            error: 'WhatsApp desconectado. Escaneie o QR Code em /qr para iniciar.' 
        });
    }

    try {
        // 2. ENTRA NA FILA COM INTERVALO HUMANO (Anti-ban / anti-bloqueio)
        const result = await enqueueWhatsAppTask(async () => {
            // Verifica se o número existe no WhatsApp
            const [registered] = await sock.onWhatsApp(cleanNumber);

            if (!registered || !registered.exists) {
                const responseData = {
                    number: cleanNumber,
                    exists: false,
                    error: 'Este número não está cadastrado no WhatsApp.'
                };
                setCache(cleanNumber, responseData);
                addLog(cleanNumber, 'NÃO CADASTRADO', 'WhatsApp');
                return { status: 404, data: responseData };
            }

            const jid = registered.jid;

            // Busca a URL da foto de perfil
            let profilePicUrl = null;
            try {
                profilePicUrl = await sock.profilePictureUrl(jid, 'image');
            } catch {
                try {
                    profilePicUrl = await sock.profilePictureUrl(jid, 'preview');
                } catch {
                    profilePicUrl = null;
                }
            }

            if (!profilePicUrl) {
                const responseData = {
                    number: cleanNumber,
                    jid,
                    exists: true,
                    hasProfilePic: false,
                    profilePicUrl: null,
                    message: 'O usuário não possui foto de perfil ou a privacidade impede a visualização.'
                };
                setCache(cleanNumber, responseData);
                addLog(cleanNumber, 'SEM FOTO', 'Privacidade ou sem foto');
                return { status: 200, data: responseData };
            }

            const responseData = {
                number: cleanNumber,
                jid,
                exists: true,
                hasProfilePic: true,
                profilePicUrl,
                directImageUrl: `/api/avatar/view?number=${cleanNumber}`
            };
            setCache(cleanNumber, responseData);
            addLog(cleanNumber, 'COM FOTO', 'Foto encontrada');
            return { status: 200, data: responseData };
        });

        return res.status(result.status).json({
            ...result.data,
            fromCache: false
        });

    } catch (error) {
        console.error('Erro ao consultar foto de perfil:', error);
        addLog(cleanNumber, 'ERRO', error.message);
        return res.status(500).json({ 
            error: 'Falha ao processar a requisição.',
            details: error.message 
        });
    }
});

// Endpoint para VISUALIZAR a imagem diretamente no navegador (sem fazer download de file.enc)
app.get('/api/avatar/view', async (req, res) => {
    let { number } = req.query;
    if (!number) return res.status(400).send('Número não informado');

    const cleanNumber = number.toString().replace(/\D/g, '');
    let profilePicUrl = null;

    const cached = getCached(cleanNumber);
    if (cached && cached.profilePicUrl) {
        profilePicUrl = cached.profilePicUrl;
    } else if (sock && isConnected) {
        try {
            const jid = `${cleanNumber}@s.whatsapp.net`;
            profilePicUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
        } catch {}
    }

    if (!profilePicUrl) {
        // Retorna um avatar padrão elegante em SVG caso o usuário não tenha foto
        const defaultAvatarSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
            <rect width="200" height="200" fill="#E1E7EB"/>
            <circle cx="100" cy="75" r="40" fill="#A0AAB0"/>
            <path d="M30 180 C30 135 65 130 100 130 C135 130 170 135 170 180 Z" fill="#A0AAB0"/>
        </svg>
        `.trim();

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(defaultAvatarSvg);
    }

    try {
        const imageRes = await fetch(profilePicUrl);
        if (!imageRes.ok) return res.status(imageRes.status).send('Erro ao carregar imagem');

        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', 'inline; filename="avatar.jpg"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Erro ao renderizar imagem: ' + err.message);
    }
});

// Inicialização
app.listen(PORT, async () => {
    console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Painel do QR Code: http://localhost:${PORT}/qr`);
    console.log(`🔍 Endpoint de consulta: http://localhost:${PORT}/api/avatar?number=NUMERO\n`);
    await connectToWhatsApp();

    // Auto Keep-Alive: faz ping automático na própria URL pública a cada 5 minutos
    // Isso impede que o Render entre em modo sleep por inatividade
    const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://api-zap-ia1g.onrender.com';
    setInterval(async () => {
        try {
            const res = await fetch(`${RENDER_EXTERNAL_URL}/status`);
            const data = await res.json();
            console.log(`[KEEP-ALIVE] Ping realizado com sucesso em ${new Date().toLocaleTimeString()} - Status: ${data.online ? 'Online' : 'Aguardando QR'}`);
        } catch (err) {
            console.warn('[KEEP-ALIVE] Falha ao fazer auto-ping:', err.message);
        }
    }, 5 * 60 * 1000); // Executa a cada 5 minutos
});
