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
        user: userProfile ? { id: userProfile.id.split(':')[0], name: userProfile.name } : null
    });
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
        return res.json({
            ...cached,
            fromCache: true
        });
    }

    if (!isConnected || !sock) {
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
            return { status: 200, data: responseData };
        });

        return res.status(result.status).json({
            ...result.data,
            fromCache: false
        });

    } catch (error) {
        console.error('Erro ao consultar foto de perfil:', error);
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
        return res.status(404).send('Foto de perfil não encontrada');
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
