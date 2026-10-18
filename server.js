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

// 2. Fila sequencial com Delay Humano (Anti-Spam / Anti-Ban)
// Garante que consultas simultâneas esperem um intervalo seguro de 1.5 a 3.5 segundos
let requestQueue = Promise.resolve();

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueWhatsAppTask(taskFn) {
    const currentTask = requestQueue.then(async () => {
        // Delay aleatório humano entre 1.5 e 3.5 segundos para não parecer robô
        const randomDelay = Math.floor(Math.random() * (3500 - 1500 + 1)) + 1500;
        await delay(randomDelay);
        return taskFn();
    });

    // Mantém a fila fluindo mesmo se alguma requisição der erro
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
            logger: pino({ level: 'info' }), // Ativa logs no Render para sabermos o estado exato
            printQRInTerminal: true,
            browser: ['Ubuntu', 'Chrome', '20.0.04']
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
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                isConnected = false;
                userProfile = null;

                console.log(`⚠️ Conexão fechada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    console.log('❌ Sessão finalizada. Limpando credenciais para novo QR...');
                    currentQR = null;
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
                profilePicUrl
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

// Inicialização
app.listen(PORT, async () => {
    console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 Painel do QR Code: http://localhost:${PORT}/qr`);
    console.log(`🔍 Endpoint de consulta: http://localhost:${PORT}/api/avatar?number=NUMERO\n`);
    await connectToWhatsApp();
});
