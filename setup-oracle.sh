#!/bin/bash
# Script de Instalação e Inicialização Automática da API Zap na Oracle Cloud (Ubuntu)
set -e

echo "============================================="
echo "🚀 Configurando API Zap na Oracle Cloud..."
echo "============================================="

# 1. Atualizar pacotes do sistema
sudo apt update && sudo apt upgrade -y

# 2. Instalar Node.js 20 LTS e Git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential

# 3. Instalar PM2 para manter a aplicação rodando 24/7
sudo npm install -g pm2

# 4. Abrir porta 3333 no firewall local (iptables / ufw)
sudo ufw allow 3333/tcp || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3333 -j ACCEPT || true
sudo netfilter-persistent save || true

# 5. Instalar dependências da aplicação
npm install

echo "============================================="
echo "✅ Configuração concluída com sucesso!"
echo "Para iniciar a API em segundo plano com PM2:"
echo "  pm2 start ecosystem.config.cjs"
echo "  pm2 save"
echo "  pm2 startup"
echo "============================================="
