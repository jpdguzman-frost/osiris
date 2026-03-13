#!/bin/bash

# Osiris Deployment Script
# Deploys the GCash Intelligence Pipeline to aux.frostdesigngroup.com/osiris

# Variables
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_USER="root"
DEST_HOST="178.128.127.92"
DEST_PORT="22443"
DEST_DIR="/mnt/volume_sgp1_01/aux/osiris"
SSH_KEY="~/.ssh/id_ed25519"
SSH_CMD="ssh -i ${SSH_KEY} -p ${DEST_PORT} ${DEST_USER}@${DEST_HOST}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Osiris Deployment...${NC}"

# ─── Step 0: Ensure remote directories exist ────────────────────────────────

echo -e "${YELLOW}📁 Creating remote directories...${NC}"
${SSH_CMD} "mkdir -p ${DEST_DIR}/data/screens"

# ─── Step 1: Sync app code (fast, small files) ──────────────────────────────

echo -e "${YELLOW}📦 Syncing app code to server...${NC}"
rsync -avz --progress \
  -e "ssh -i ${SSH_KEY} -p ${DEST_PORT}" \
  --include='server.js' \
  --include='package.json' \
  --include='package-lock.json' \
  --include='src/' \
  --include='src/**' \
  --include='scripts/' \
  --include='scripts/**' \
  --include='config/' \
  --include='config/**' \
  --include='frontend/' \
  --include='frontend/**' \
  --exclude='config/.env' \
  --exclude='node_modules' \
  --exclude='*' \
  ${SRC_DIR}/ ${DEST_USER}@${DEST_HOST}:${DEST_DIR}/

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ App code synced successfully${NC}"
else
    echo -e "${RED}❌ App code sync failed${NC}"
    exit 1
fi

# ─── Step 2: Sync screen data (large, separate step) ────────────────────────

echo ""
read -p "$(echo -e ${YELLOW}"📸 Sync screen data (data/screens/)? This can be large. [y/N]: "${NC})" SYNC_SCREENS

if [[ "$SYNC_SCREENS" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}📸 Syncing screen data...${NC}"
    rsync -avz --progress \
      -e "ssh -i ${SSH_KEY} -p ${DEST_PORT}" \
      ${SRC_DIR}/data/screens/ ${DEST_USER}@${DEST_HOST}:${DEST_DIR}/data/screens/

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Screen data synced successfully${NC}"
    else
        echo -e "${RED}❌ Screen data sync failed${NC}"
        exit 1
    fi
else
    echo -e "${BLUE}⏭  Skipping screen data sync${NC}"
fi

# ─── Step 2b: Sync analysis data ─────────────────────────────────────────────

echo ""
read -p "$(echo -e ${YELLOW}"📊 Sync analysis data (data/analysis/)? [y/N]: "${NC})" SYNC_ANALYSIS

if [[ "$SYNC_ANALYSIS" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}📊 Syncing analysis data...${NC}"
    ${SSH_CMD} "mkdir -p ${DEST_DIR}/data/analysis"
    rsync -avz --progress \
      -e "ssh -i ${SSH_KEY} -p ${DEST_PORT}" \
      ${SRC_DIR}/data/analysis/ ${DEST_USER}@${DEST_HOST}:${DEST_DIR}/data/analysis/

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Analysis data synced successfully${NC}"
    else
        echo -e "${RED}❌ Analysis data sync failed${NC}"
        exit 1
    fi
else
    echo -e "${BLUE}⏭  Skipping analysis data sync${NC}"
fi

# ─── Step 3: Install dependencies ───────────────────────────────────────────

echo -e "${YELLOW}📚 Installing production dependencies on remote server...${NC}"
${SSH_CMD} "source ~/.nvm/nvm.sh && cd ${DEST_DIR} && npm install --production"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Dependencies installed successfully${NC}"
else
    echo -e "${RED}❌ Dependency installation failed${NC}"
    exit 1
fi

# ─── Step 4: Check .env ─────────────────────────────────────────────────────

echo -e "${YELLOW}🔐 Checking environment configuration...${NC}"
${SSH_CMD} "
if [ ! -f ${DEST_DIR}/config/.env ]; then
    echo 'WARNING: config/.env not found!'
    echo 'Create it with:'
    echo '  PORT=3001'
    echo '  BASE_PATH=/osiris'
    echo '  MONGODB_URI=mongodb://localhost:27017'
    echo '  ANTHROPIC_API_KEY=sk-ant-...'
fi
"

# ─── Step 5: Restart PM2 ────────────────────────────────────────────────────

echo -e "${YELLOW}🔄 Restarting Osiris service...${NC}"
${SSH_CMD} "source ~/.nvm/nvm.sh && cd ${DEST_DIR} && pm2 restart osiris --update-env 2>/dev/null || pm2 start server.js --name osiris -- --env production && pm2 save"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ PM2 service restarted successfully${NC}"
else
    echo -e "${RED}❌ Failed to restart PM2 service${NC}"
    exit 1
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
echo ""
echo -e "${BLUE}📋 Post-deployment checklist:${NC}"
echo -e "   ${YELLOW}Required Configuration (config/.env):${NC}"
echo -e "   • PORT=3950"
echo -e "   • BASE_PATH=/osiris"
echo -e "   • MONGODB_URI=mongodb://localhost:27017"
echo -e "   • ANTHROPIC_API_KEY=sk-ant-..."
echo ""
echo -e "   ${YELLOW}Apache Config (add to aux.frostdesigngroup.com VirtualHost):${NC}"
echo -e "   • ProxyPreserveHost On"
echo -e "   • ProxyPass /osiris http://localhost:3001/osiris"
echo -e "   • ProxyPassReverse /osiris http://localhost:3001/osiris"
echo ""
echo -e "   ${YELLOW}Verification:${NC}"
echo -e "   • Test: https://aux.frostdesigngroup.com/osiris/frontend/"
echo -e "   • API:  https://aux.frostdesigngroup.com/osiris/api/stats"
echo -e "   • PM2:  pm2 status osiris"
echo -e "   • Logs: pm2 logs osiris"
echo ""
