/**
 * ============================================================
 * MaBoutique - Gestion de Stock, Caisse & Assistant Plantes
 * ============================================================
 * Technologies : Node.js + Express + SQLite + EJS + Multer + CSRF
 * Design       : Spring Plants (vert naturel, beige, épuré)
 * Auteur       : Full-stack refonte
 * ============================================================
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const expressLayouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
   CONFIGURATION MULTER (upload images)
   ============================================================ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Seules les images JPEG, PNG et WEBP sont acceptées'));
  }
});

/* ============================================================
   MIDDLEWARES GLOBAUX
   ============================================================ */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

/* ============================================================
   SESSIONS
   ============================================================ */
const sessionSecret = process.env.SESSION_SECRET || 'ma-boutique-secret-key-2026';
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // dev / Replit
    maxAge: 24 * 60 * 60 * 1000 // 24h
  }
}));

/* ============================================================
   CSRF (exclure login)
   ============================================================ */
const csrfProtection = csrf({ cookie: true });
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  csrfProtection(req, res, next);
});
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    req.session.flash = { type: 'error', message: 'Session invalide, veuillez réessayer.' };
    return res.redirect('back');
  }
  next(err);
});

/* ============================================================
   BASE DE DONNÉES SQLITE
   ============================================================ */
const db = new sqlite3.Database(path.join(__dirname, 'database.db'));

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); });
  });
}

/* ============================================================
   CRÉATION DES TABLES + SEED
   ============================================================ */
async function initDB() {
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'collaborateur',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS produits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL,
    nom TEXT NOT NULL,
    seuil_alerte INTEGER NOT NULL DEFAULT 5,
    prix_achat REAL NOT NULL DEFAULT 0,
    prix_vente REAL NOT NULL DEFAULT 0,
    image TEXT,
    actif INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS mouvements_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    produit_id INTEGER NOT NULL,
    quantite INTEGER NOT NULL,
    prix_vente_effectif REAL,
    date_mouvement DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    commentaire TEXT,
    FOREIGN KEY (produit_id) REFERENCES produits(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS mouvements_caisse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    montant REAL NOT NULL,
    motif TEXT NOT NULL,
    est_lie_vente INTEGER DEFAULT 0,
    vente_id INTEGER,
    est_cloture INTEGER DEFAULT 0,
    date_mouvement DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    commentaire TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Seed utilisateurs
  const count = await dbGet('SELECT COUNT(*) as c FROM users');
  if (count.c === 0) {
    const hashAdmin = await bcrypt.hash('admin123', 10);
    const hashCollab = await bcrypt.hash('collab123', 10);
    await dbRun('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', ['admin@example.com', hashAdmin, 'admin']);
    await dbRun('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', ['collab@example.com', hashCollab, 'collaborateur']);
    console.log('🌱 Utilisateurs de test créés');
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'error', message: 'Veuillez vous connecter.' };
    return res.redirect('/login');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    req.session.flash = { type: 'error', message: "Accès réservé à l'administrateur." };
    return res.redirect('/dashboard');
  }
  next();
}
async function logAction(userId, action, description) {
  await dbRun('INSERT INTO logs (user_id, action, description) VALUES (?, ?, ?)', [userId || null, action, description || '']);
}
async function getStock(produitId) {
  const row = await dbGet(`
    SELECT 
      COALESCE(SUM(CASE WHEN type IN ('entree','ajustement') THEN quantite ELSE 0 END),0) -
      COALESCE(SUM(CASE WHEN type IN ('sortie','vente') THEN quantite ELSE 0 END),0) as stock
    FROM mouvements_stock WHERE produit_id = ?
  `, [produitId]);
  return row ? row.stock : 0;
}
async function getSoldeCaisse() {
  const row = await dbGet(`
    SELECT COALESCE(SUM(CASE WHEN type = 'entree' THEN montant ELSE 0 END),0) -
           COALESCE(SUM(CASE WHEN type = 'sortie' THEN montant ELSE 0 END),0) as solde
    FROM mouvements_caisse
  `);
  return row ? row.solde : 0;
}

/* ============================================================
   CRON : CLÔTURE AUTOMATIQUE 23h00
   ============================================================ */
cron.schedule('0 23 * * *', async () => {
  console.log('⏰ Clôture automatique de caisse déclenchée...');
  try {
    const solde = await getSoldeCaisse();
    if (solde === 0) {
      console.log('   Solde déjà à 0, aucune action nécessaire.');
      return;
    }
    const today = new Date().toLocaleDateString('fr-FR');
    const admin = await dbGet("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const adminId = admin ? admin.id : null;

    if (solde > 0) {
      await dbRun(`INSERT INTO mouvements_caisse (type, montant, motif, est_cloture, user_id, commentaire)
        VALUES (?, ?, ?, 1, ?, ?)`,
        ['sortie', solde, `Clôture automatique du ${today}`, adminId, 'Clôture auto 23h00']);
    } else {
      await dbRun(`INSERT INTO mouvements_caisse (type, montant, motif, est_cloture, user_id, commentaire)
        VALUES (?, ?, ?, 1, ?, ?)`,
        ['entree', Math.abs(solde), `Clôture automatique du ${today}`, adminId, 'Clôture auto 23h00']);
    }
    await logAction(adminId, 'Clôture automatique', `Solde ajusté : ${solde} FCFA`);
    console.log('   ✅ Clôture automatique effectuée. Solde ajusté :', solde);
  } catch (e) {
    console.error('   ❌ Erreur clôture automatique :', e.message);
  }
});

/* ============================================================
   FLASH MESSAGES MIDDLEWARE
   ============================================================ */
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  next();
});

/* ============================================================
   ROUTES AUTH
   ============================================================ */
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { csrfToken: req.csrfToken ? req.csrfToken() : '' });
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      req.session.flash = { type: 'error', message: 'Email ou mot de passe incorrect.' };
      return res.redirect('/login');
    }
    req.session.regenerate(() => {
      req.session.user = { id: user.id, email: user.email, role: user.role };
      req.session.flash = { type: 'success', message: `Bienvenue, ${user.email} !` };
      res.redirect('/dashboard');
    });
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', message: 'Erreur de connexion.' };
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ============================================================
   ROUTE DASHBOARD
   ============================================================ */
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const produits = await dbAll('SELECT * FROM produits WHERE actif = 1 ORDER BY nom');
    for (const p of produits) {
      p.stock = await getStock(p.id);
      p.alerte = p.stock <= p.seuil_alerte;
    }
    const solde = await getSoldeCaisse();
    const totalVentes = await dbGet("SELECT COUNT(*) as c FROM mouvements_stock WHERE type = 'vente'");
    const caJour = await dbGet(`
      SELECT COALESCE(SUM(quantite * prix_vente_effectif),0) as ca
      FROM mouvements_stock WHERE type = 'vente' AND date(date_mouvement) = date('now')
    `);
    res.render('dashboard', {
      produits,
      solde,
      totalVentes: totalVentes.c,
      caJour: caJour.ca
    });
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', message: 'Erreur chargement dashboard.' };
    res.redirect('/login');
  }
});

/* ============================================================
   ROUTES PRODUITS (admin)
   ============================================================ */
app.get('/produits', requireAuth, requireAdmin, async (req, res) => {
  try {
    const q = req.query.q || '';
    let sql = 'SELECT * FROM produits WHERE actif = 1';
    const params = [];
    if (q) { sql += ' AND (nom LIKE ? OR reference LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY nom';
    const produits = await dbAll(sql, params);
    for (const p of produits) { p.stock = await getStock(p.id); p.alerte = p.stock <= p.seuil_alerte; }
    res.render('produits', { produits, q });
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', message: 'Erreur chargement produits.' };
    res.redirect('/dashboard');
  }
});

app.get('/produits/nouveau', requireAuth, requireAdmin, (req, res) => {
  res.render('produit-form', { produit: null });
});

app.get('/produits/:id/modifier', requireAuth, requireAdmin, async (req, res) => {
  try {
    const produit = await dbGet('SELECT * FROM produits WHERE id = ?', [req.params.id]);
    if (!produit) return res.redirect('/produits');
    res.render('produit-form', { produit });
  } catch (e) {
    res.redirect('/produits');
  }
});

app.post('/produits', requireAuth, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { reference, nom, seuil_alerte, prix_achat, prix_vente } = req.body;
    if (!reference || !nom || !prix_vente) {
      req.session.flash = { type: 'error', message: 'Champs obligatoires manquants.' };
      return res.redirect('/produits/nouveau');
    }
    const image = req.file ? '/uploads/' + req.file.filename : null;
    await dbRun('INSERT INTO produits (reference, nom, seuil_alerte, prix_achat, prix_vente, image) VALUES (?, ?, ?, ?, ?, ?)',
      [reference, nom, parseInt(seuil_alerte) || 5, parseFloat(prix_achat) || 0, parseFloat(prix_vente), image]);
    await logAction(req.session.user.id, 'Création produit', `Produit ${nom} (${reference})`);
    req.session.flash = { type: 'success', message: 'Produit créé avec succès.' };
    res.redirect('/produits');
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', message: e.message.includes('UNIQUE') ? 'Référence déjà utilisée.' : 'Erreur création produit.' };
    res.redirect('/produits/nouveau');
  }
});

app.post('/produits/:id/modifier', requireAuth, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { reference, nom, seuil_alerte, prix_achat, prix_vente } = req.body;
    const existing = await dbGet('SELECT image FROM produits WHERE id = ?', [req.params.id]);
    const image = req.file ? '/uploads/' + req.file.filename : (existing ? existing.image : null);
    await dbRun('UPDATE produits SET reference=?, nom=?, seuil_alerte=?, prix_achat=?, prix_vente=?, image=? WHERE id=?',
      [reference, nom, parseInt(seuil_alerte) || 5, parseFloat(prix_achat) || 0, parseFloat(prix_vente), image, req.params.id]);
    await logAction(req.session.user.id, 'Modification produit', `Produit ${nom} (#${req.params.id})`);
    req.session.flash = { type: 'success', message: 'Produit modifié avec succès.' };
    res.redirect('/produits');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur modification produit.' };
    res.redirect('/produits');
  }
});

app.post('/produits/:id/supprimer', requireAuth, requireAdmin, async (req, res) => {
  try {
    await dbRun('UPDATE produits SET actif = 0 WHERE id = ?', [req.params.id]);
    await logAction(req.session.user.id, 'Suppression produit', `Produit #${req.params.id}`);
    req.session.flash = { type: 'success', message: 'Produit supprimé.' };
    res.redirect('/produits');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur suppression.' };
    res.redirect('/produits');
  }
});

/* ============================================================
   ROUTE VENTE (tous)
   ============================================================ */
app.get('/vente', requireAuth, async (req, res) => {
  try {
    const produits = await dbAll('SELECT * FROM produits WHERE actif = 1 ORDER BY nom');
    for (const p of produits) { p.stock = await getStock(p.id); }
    res.render('vente', { produits });
  } catch (e) {
    res.redirect('/dashboard');
  }
});

app.post('/vente', requireAuth, async (req, res) => {
  const { produit_id, quantite, prix_vente_effectif, commentaire, date_mouvement } = req.body;
  const qte = parseInt(quantite);
  if (!produit_id || !qte || qte <= 0) {
    req.session.flash = { type: 'error', message: 'Quantité invalide.' };
    return res.redirect('/vente');
  }
  try {
    const stock = await getStock(produit_id);
    if (stock < qte) {
      req.session.flash = { type: 'error', message: `Stock insuffisant (disponible : ${stock}).` };
      return res.redirect('/vente');
    }
    const produit = await dbGet('SELECT * FROM produits WHERE id = ?', [produit_id]);
    const prix = parseFloat(prix_vente_effectif) || produit.prix_vente;
    const total = qte * prix;
    const dateMvt = date_mouvement || new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(`INSERT INTO mouvements_stock (type, produit_id, quantite, prix_vente_effectif, date_mouvement, user_id, commentaire)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['vente', produit_id, qte, prix, dateMvt, req.session.user.id, commentaire || ''],
          function(err) {
            if (err) { db.run('ROLLBACK'); return reject(err); }
            const venteId = this.lastID;
            db.run(`INSERT INTO mouvements_caisse (type, montant, motif, est_lie_vente, vente_id, user_id, commentaire)
              VALUES (?, ?, ?, 1, ?, ?, ?)`,
              ['entree', total, `Vente de ${produit.nom} (x${qte})`, venteId, req.session.user.id, commentaire || ''],
              function(err2) {
                if (err2) { db.run('ROLLBACK'); return reject(err2); }
                db.run('COMMIT', (err3) => {
                  if (err3) { db.run('ROLLBACK'); return reject(err3); }
                  resolve(venteId);
                });
              });
          });
      });
    });

    await logAction(req.session.user.id, 'Vente', `${produit.nom} x${qte} = ${total} FCFA`);
    req.session.flash = { type: 'success', message: `Vente enregistrée : ${total} FCFA` };
    res.redirect('/dashboard');
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', message: 'Erreur lors de la vente.' };
    res.redirect('/vente');
  }
});

/* ============================================================
   ROUTE STOCK (entrée/sortie manuelle)
   ============================================================ */
app.get('/stock', requireAuth, async (req, res) => {
  try {
    const produits = await dbAll('SELECT * FROM produits WHERE actif = 1 ORDER BY nom');
    for (const p of produits) { p.stock = await getStock(p.id); }
    res.render('stock', { produits });
  } catch (e) { res.redirect('/dashboard'); }
});

app.post('/stock/entree', requireAuth, async (req, res) => {
  const { produit_id, quantite, prix_achat_unitaire, date_mouvement, payer_caisse, commentaire } = req.body;
  const qte = parseInt(quantite);
  if (!produit_id || !qte || qte <= 0) {
    req.session.flash = { type: 'error', message: 'Quantité invalide.' };
    return res.redirect('/stock');
  }
  try {
    const produit = await dbGet('SELECT * FROM produits WHERE id = ?', [produit_id]);
    const prixUnit = parseFloat(prix_achat_unitaire) || produit.prix_achat;
    const total = qte * prixUnit;
    const dateMvt = date_mouvement || new Date().toISOString();

    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run(`INSERT INTO mouvements_stock (type, produit_id, quantite, date_mouvement, user_id, commentaire)
          VALUES (?, ?, ?, ?, ?, ?)`,
          ['entree', produit_id, qte, dateMvt, req.session.user.id, commentaire || ''],
          function(err) {
            if (err) { db.run('ROLLBACK'); return reject(err); }
            if (payer_caisse) {
              db.run(`INSERT INTO mouvements_caisse (type, montant, motif, user_id, commentaire)
                VALUES (?, ?, ?, ?, ?)`,
                ['sortie', total, `Achat stock ${produit.nom}`, req.session.user.id, commentaire || ''],
                function(err2) {
                  if (err2) { db.run('ROLLBACK'); return reject(err2); }
                  db.run('COMMIT', (err3) => { if (err3) { db.run('ROLLBACK'); return reject(err3); } resolve(); });
                });
            } else {
              db.run('COMMIT', (err3) => { if (err3) { db.run('ROLLBACK'); return reject(err3); } resolve(); });
            }
          });
      });
    });

    await logAction(req.session.user.id, 'Entrée stock', `${produit.nom} +${qte} (payer caisse: ${payer_caisse ? 'oui' : 'non'})`);
    req.session.flash = { type: 'success', message: 'Entrée stock enregistrée.' };
    res.redirect('/stock');
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', message: 'Erreur entrée stock.' };
    res.redirect('/stock');
  }
});

app.post('/stock/sortie', requireAuth, async (req, res) => {
  const { produit_id, quantite, motif, date_mouvement, commentaire } = req.body;
  const qte = parseInt(quantite);
  if (!produit_id || !qte || qte <= 0) {
    req.session.flash = { type: 'error', message: 'Quantité invalide.' };
    return res.redirect('/stock');
  }
  try {
    const stock = await getStock(produit_id);
    if (stock < qte) {
      req.session.flash = { type: 'error', message: `Stock insuffisant (disponible : ${stock}).` };
      return res.redirect('/stock');
    }
    const dateMvt = date_mouvement || new Date().toISOString();
    await dbRun(`INSERT INTO mouvements_stock (type, produit_id, quantite, date_mouvement, user_id, commentaire)
      VALUES (?, ?, ?, ?, ?, ?)`,
      ['sortie', produit_id, qte, dateMvt, req.session.user.id, `${motif || 'Autre'} - ${commentaire || ''}`]);
    const produit = await dbGet('SELECT nom FROM produits WHERE id = ?', [produit_id]);
    await logAction(req.session.user.id, 'Sortie stock', `${produit.nom} -${qte} (${motif || 'Autre'})`);
    req.session.flash = { type: 'success', message: 'Sortie stock enregistrée.' };
    res.redirect('/stock');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur sortie stock.' };
    res.redirect('/stock');
  }
});

/* ============================================================
   ROUTE CAISSE
   ============================================================ */
app.get('/caisse', requireAuth, async (req, res) => {
  try {
    const solde = await getSoldeCaisse();
    const historique = await dbAll(`
      SELECT mc.*, u.email as user_email
      FROM mouvements_caisse mc
      LEFT JOIN users u ON mc.user_id = u.id
      ORDER BY mc.date_mouvement DESC LIMIT 100
    `);
    const clotures = await dbAll(`
      SELECT mc.*, u.email as user_email
      FROM mouvements_caisse mc
      LEFT JOIN users u ON mc.user_id = u.id
      WHERE mc.est_cloture = 1
      ORDER BY mc.date_mouvement DESC
    `);
    res.render('caisse', { solde, historique, clotures });
  } catch (e) {
    console.error(e);
    res.redirect('/dashboard');
  }
});

app.post('/caisse/entree', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { montant, motif, commentaire } = req.body;
    if (!montant || parseFloat(montant) <= 0) {
      req.session.flash = { type: 'error', message: 'Montant invalide.' };
      return res.redirect('/caisse');
    }
    await dbRun(`INSERT INTO mouvements_caisse (type, montant, motif, user_id, commentaire) VALUES (?, ?, ?, ?, ?)`,
      ['entree', parseFloat(montant), motif, req.session.user.id, commentaire || '']);
    await logAction(req.session.user.id, 'Entrée caisse', `${montant} FCFA - ${motif}`);
    req.session.flash = { type: 'success', message: 'Entrée caisse enregistrée.' };
    res.redirect('/caisse');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur entrée caisse.' };
    res.redirect('/caisse');
  }
});

app.post('/caisse/sortie', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { montant, motif, commentaire } = req.body;
    if (!montant || parseFloat(montant) <= 0) {
      req.session.flash = { type: 'error', message: 'Montant invalide.' };
      return res.redirect('/caisse');
    }
    await dbRun(`INSERT INTO mouvements_caisse (type, montant, motif, user_id, commentaire) VALUES (?, ?, ?, ?, ?)`,
      ['sortie', parseFloat(montant), motif, req.session.user.id, commentaire || '']);
    await logAction(req.session.user.id, 'Sortie caisse', `${montant} FCFA - ${motif}`);
    req.session.flash = { type: 'success', message: 'Sortie caisse enregistrée.' };
    res.redirect('/caisse');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur sortie caisse.' };
    res.redirect('/caisse');
  }
});

/* ============================================================
   HISTORIQUES
   ============================================================ */
app.get('/historique-stock', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT ms.*, p.nom as produit_nom, u.email as user_email
      FROM mouvements_stock ms
      LEFT JOIN produits p ON ms.produit_id = p.id
      LEFT JOIN users u ON ms.user_id = u.id
      ORDER BY ms.date_mouvement DESC LIMIT 200
    `);
    res.render('historique-stock', { rows });
  } catch (e) { res.redirect('/dashboard'); }
});

app.get('/historique-caisse', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT mc.*, u.email as user_email
      FROM mouvements_caisse mc
      LEFT JOIN users u ON mc.user_id = u.id
      ORDER BY mc.date_mouvement DESC LIMIT 200
    `);
    res.render('historique-caisse', { rows });
  } catch (e) { res.redirect('/dashboard'); }
});

/* ============================================================
   ANNULATION VENTE (admin)
   ============================================================ */
app.post('/ventes/:id/annuler', requireAuth, requireAdmin, async (req, res) => {
  try {
    const vente = await dbGet('SELECT * FROM mouvements_stock WHERE id = ? AND type = "vente"', [req.params.id]);
    if (!vente) {
      req.session.flash = { type: 'error', message: 'Vente introuvable.' };
      return res.redirect('/historique-stock');
    }
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('DELETE FROM mouvements_caisse WHERE vente_id = ?', [req.params.id], function(err) {
          if (err) { db.run('ROLLBACK'); return reject(err); }
          db.run('DELETE FROM mouvements_stock WHERE id = ?', [req.params.id], function(err2) {
            if (err2) { db.run('ROLLBACK'); return reject(err2); }
            db.run('COMMIT', (err3) => { if (err3) { db.run('ROLLBACK'); return reject(err3); } resolve(); });
          });
        });
      });
    });
    await logAction(req.session.user.id, 'Annulation vente', `Vente #${req.params.id} annulée`);
    req.session.flash = { type: 'success', message: 'Vente annulée avec succès.' };
    res.redirect('/historique-stock');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur annulation vente.' };
    res.redirect('/historique-stock');
  }
});

/* ============================================================
   RAPPORTS (admin)
   ============================================================ */
app.get('/rapports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const periode = req.query.periode || 'jour';
    let dateCond = "date(ms.date_mouvement) = date('now')";
    if (periode === 'semaine') dateCond = "date_mouvement >= date('now', '-7 days')";
    if (periode === 'mois') dateCond = "date_mouvement >= date('now', '-30 days')";
    if (periode === 'perso' && req.query.debut && req.query.fin) {
      dateCond = `date_mouvement BETWEEN '${req.query.debut}' AND '${req.query.fin}'`;
    }

    const ventes = await dbAll(`
      SELECT ms.*, p.nom as produit_nom, p.prix_achat
      FROM mouvements_stock ms
      LEFT JOIN produits p ON ms.produit_id = p.id
      WHERE ms.type = 'vente' AND ${dateCond}
      ORDER BY ms.date_mouvement DESC
    `);

    let ca = 0, nbVentes = ventes.length, benefice = 0;
    const caParJour = {};
    for (const v of ventes) {
      const total = v.quantite * v.prix_vente_effectif;
      ca += total;
      benefice += total - (v.quantite * (v.prix_achat || 0));
      const jour = v.date_mouvement.split('T')[0];
      caParJour[jour] = (caParJour[jour] || 0) + total;
    }

    const labels = Object.keys(caParJour).sort();
    const data = labels.map(d => caParJour[d]);

    res.render('rapports', { periode, ventes, ca, nbVentes, benefice, labels, data, debut: req.query.debut || '', fin: req.query.fin || '' });
  } catch (e) {
    console.error(e);
    res.redirect('/dashboard');
  }
});

app.get('/rapports/export', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ventes = await dbAll(`
      SELECT ms.*, p.nom as produit_nom
      FROM mouvements_stock ms
      LEFT JOIN produits p ON ms.produit_id = p.id
      WHERE ms.type = 'vente'
      ORDER BY ms.date_mouvement DESC
    `);
    const csvPath = path.join(__dirname, 'public', 'uploads', 'rapport_ventes.csv');
    const writer = createCsvWriter({
      path: csvPath,
      header: [
        { id: 'id', title: 'ID' },
        { id: 'produit_nom', title: 'Produit' },
        { id: 'quantite', title: 'Quantité' },
        { id: 'prix_vente_effectif', title: 'Prix unitaire' },
        { id: 'total', title: 'Total' },
        { id: 'date_mouvement', title: 'Date' },
        { id: 'commentaire', title: 'Commentaire' }
      ]
    });
    const records = ventes.map(v => ({
      ...v,
      total: v.quantite * v.prix_vente_effectif
    }));
    await writer.writeRecords(records);
    res.download(csvPath, 'rapport_ventes.csv');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur export CSV.' };
    res.redirect('/rapports');
  }
});

/* ============================================================
   UTILISATEURS (admin)
   ============================================================ */
app.get('/utilisateurs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, email, role, created_at FROM users ORDER BY id');
    res.render('utilisateurs', { users });
  } catch (e) { res.redirect('/dashboard'); }
});

app.post('/utilisateurs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) {
      req.session.flash = { type: 'error', message: 'Email et mot de passe obligatoires.' };
      return res.redirect('/utilisateurs');
    }
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      req.session.flash = { type: 'error', message: 'Email déjà utilisé.' };
      return res.redirect('/utilisateurs');
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', [email, hash, role || 'collaborateur']);
    await logAction(req.session.user.id, 'Création utilisateur', `Compte ${email} (${role || 'collaborateur'})`);
    req.session.flash = { type: 'success', message: 'Utilisateur créé.' };
    res.redirect('/utilisateurs');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur création utilisateur.' };
    res.redirect('/utilisateurs');
  }
});

app.post('/utilisateurs/:id/supprimer', requireAuth, requireAdmin, async (req, res) => {
  try {
    await dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
    await logAction(req.session.user.id, 'Suppression utilisateur', `Utilisateur #${req.params.id}`);
    req.session.flash = { type: 'success', message: 'Utilisateur supprimé.' };
    res.redirect('/utilisateurs');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur suppression utilisateur.' };
    res.redirect('/utilisateurs');
  }
});

/* ============================================================
   JOURNAL (admin)
   ============================================================ */
app.get('/journal', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { user_id, action, debut, fin } = req.query;
    let sql = `
      SELECT l.*, u.email as user_email
      FROM logs l
      LEFT JOIN users u ON l.user_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (user_id) { sql += ' AND l.user_id = ?'; params.push(user_id); }
    if (action) { sql += ' AND l.action LIKE ?'; params.push(`%${action}%`); }
    if (debut) { sql += ' AND date(l.created_at) >= ?'; params.push(debut); }
    if (fin) { sql += ' AND date(l.created_at) <= ?'; params.push(fin); }
    sql += ' ORDER BY l.created_at DESC LIMIT 300';
    const logs = await dbAll(sql, params);
    const users = await dbAll('SELECT id, email FROM users ORDER BY email');
    res.render('journal', { logs, users, filters: { user_id, action, debut, fin } });
  } catch (e) { res.redirect('/dashboard'); }
});

app.get('/journal/export', requireAuth, requireAdmin, async (req, res) => {
  try {
    const logs = await dbAll(`
      SELECT l.*, u.email as user_email
      FROM logs l
      LEFT JOIN users u ON l.user_id = u.id
      ORDER BY l.created_at DESC
    `);
    const csvPath = path.join(__dirname, 'public', 'uploads', 'journal.csv');
    const writer = createCsvWriter({
      path: csvPath,
      header: [
        { id: 'created_at', title: 'Date' },
        { id: 'user_email', title: 'Utilisateur' },
        { id: 'action', title: 'Action' },
        { id: 'description', title: 'Détail' }
      ]
    });
    await writer.writeRecords(logs);
    res.download(csvPath, 'journal.csv');
  } catch (e) {
    req.session.flash = { type: 'error', message: 'Erreur export journal.' };
    res.redirect('/journal');
  }
});

/* ============================================================
   CHATBOT GEMINI
   ============================================================ */
app.get('/chatbot', requireAuth, (req, res) => {
  res.render('chatbot');
});

app.post('/api/chatbot', requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) {
      return res.json({ error: 'Question vide.' });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.json({ error: 'Clé API Gemini non configurée.' });
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const systemPrompt = `Tu es un assistant spécialisé en botanique. Réponds uniquement aux questions sur les plantes, le jardinage, l'entretien, les maladies des végétaux. Si la question est hors sujet, réponds poliment que tu es spécialiste des plantes et ne peux pas répondre à autre chose. Sois concis et utile.`;
    const result = await model.generateContent(`${systemPrompt}\n\nQuestion : ${question}`);
    const response = await result.response;
    const text = response.text();
    res.json({ answer: text });
  } catch (e) {
    console.error('Chatbot error:', e);
    res.json({ error: 'Erreur de communication avec Gemini.' });
  }
});

/* ============================================================
   API JSON (pour autocomplétion, etc.)
   ============================================================ */
app.get('/api/produits', requireAuth, async (req, res) => {
  try {
    const produits = await dbAll('SELECT * FROM produits WHERE actif = 1 ORDER BY nom');
    for (const p of produits) { p.stock = await getStock(p.id); }
    res.json(produits);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/produit/:id', requireAuth, async (req, res) => {
  try {
    const p = await dbGet('SELECT * FROM produits WHERE id = ?', [req.params.id]);
    if (p) p.stock = await getStock(p.id);
    res.json(p || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   PAGE 404
   ============================================================ */
app.use((req, res) => {
  res.status(404).render('login', { csrfToken: '', error404: true });
});

/* ============================================================
   DÉMARRAGE
   ============================================================ */
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🌿 MaBoutique démarrée sur http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Erreur init DB:', err);
});
