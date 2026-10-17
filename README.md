# API Zap - Consulta de Foto de Perfil WhatsApp

API REST construída em Node.js com Express e Baileys para verificar a existência de números no WhatsApp e obter a URL da foto de perfil.

## Recursos
- Verificação automática se o número existe no WhatsApp (através de `sock.onWhatsApp`).
- Busca da foto de perfil em alta definição (`image`) ou miniatura (`preview`).
- Tratamento para casos onde o usuário não tem foto ou possui privacidade ativada.
- Página amigável para escanear o QR Code no navegador (`/qr`).
- Exibição de QR Code diretamente no terminal.

---

## Como Rodar

1. **Instalar as dependências** (caso ainda não tenha feito):
   ```bash
   npm install
   ```

2. **Iniciar o servidor**:
   ```bash
   npm start
   ```
   *(ou `npm run dev` para recarregar automaticamente ao alterar arquivos)*

3. **Conectar seu WhatsApp**:
   - Escaneie o QR Code exibido no terminal ou abra no navegador:
     👉 [http://localhost:3333/qr](http://localhost:3333/qr)
   - Vá no seu celular: **WhatsApp > Configurações / Aparelhos conectados > Conectar um aparelho**.

---

## Endpoints

### 1. Consultar Foto de Perfil
- **Rota**: `GET /api/avatar?number={NUMERO}`
- **Exemplo**: `http://localhost:3333/api/avatar?number=5511999999999`
- **Resposta com Foto**:
  ```json
  {
    "number": "5511999999999",
    "jid": "5511999999999@s.whatsapp.net",
    "exists": true,
    "hasProfilePic": true,
    "profilePicUrl": "https://pps.whatsapp.net/v/t61.24694-24/..."
  }
  ```
- **Resposta sem foto / com privacidade**:
  ```json
  {
    "number": "5511999999999",
    "jid": "5511999999999@s.whatsapp.net",
    "exists": true,
    "hasProfilePic": false,
    "profilePicUrl": null,
    "message": "O usuário não possui foto de perfil ou a privacidade impede a visualização."
  }
  ```

### 2. Status do Serviço
- **Rota**: `GET /status`
- **Exemplo**: `http://localhost:3333/status`
- **Resposta**:
  ```json
  {
    "online": true,
    "message": "WhatsApp conectado e pronto para consultas.",
    "user": {
      "id": "551188888888",
      "name": "Seu Nome"
    }
  }
  ```

### 3. Visualizar QR Code no Navegador
- **Rota**: `GET /qr`
- Abre uma interface HTML com a imagem do QR Code para autenticação.
