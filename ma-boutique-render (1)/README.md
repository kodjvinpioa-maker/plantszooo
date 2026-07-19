# 🌿 MaBoutique

Application web de gestion de stock, petite caisse et assistant plantes (Gemini AI).

## Déploiement sur Render

1. Crée un **Web Service** sur Render
2. Connecte ton repo GitHub ou upload le zip
3. Définis les variables d'environnement :
   - `SESSION_SECRET` = une chaîne aléatoire longue
   - `GEMINI_API_KEY` = ta clé API Google Gemini (optionnel pour le chatbot)
4. Laisser **Build Command** vide (ou `npm install`)
5. **Start Command** : `node server.js`
6. Déployer !

## Comptes de test

| Rôle | Email | Mot de passe |
|------|-------|-------------|
| Admin | admin@example.com | admin123 |
| Collaborateur | collab@example.com | collab123 |

## Fonctionnalités

- 🔐 Authentification sessions + bcrypt
- 🛡️ Protection CSRF sur tous les formulaires
- 📦 Gestion produits (CRUD admin) avec upload photo
- 💰 Ventes avec autocomplétion et vérification stock
- 📥 Entrées / sorties de stock manuelles
- 💵 Caisse en temps réel avec clôture automatique (23h)
- 📊 Rapports avec graphiques Chart.js + export CSV
- 📓 Journal d'activité complet (admin)
- 🤖 Chatbot Gemini spécialisé botanique
- 📱 Design responsive mobile-first

## Stack

Node.js + Express + SQLite + EJS + Multer + CSRF + node-cron + Google Generative AI
