const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const fs = require('fs');

dotenv.config();
const app = express();

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'placement_db',
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false 
});

const sessionStore = new MySQLStore({}, db); 
app.use(session({
    key: 'placement_portal_session',
    secret: 'placement_portal_secret',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } 
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

const requireLogin = (req, res, next) => {
    if (req.session.user) { next(); } else { res.redirect('/login'); }
};

// --- ROUTES ---
app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores: scores });
    } catch (err) { res.render('dashboard', { user: req.session.user, scores: [] }); }
});

app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, password]);
        res.render('login', { msg: 'Account Created!', error: null });
    } catch (err) { res.render('register', { error: 'Email exists.' }); }
});
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0 && users[0].password === password) {
            req.session.user = users[0]; 
            res.redirect('/'); 
        } else { res.render('login', { error: 'Wrong Credentials', msg: null }); }
    } catch (err) { res.render('login', { error: 'Server Error', msg: null }); }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// TOPIC NAVIGATION
app.get('/aptitude-topics', requireLogin, async (req, res) => {
    const [topics] = await db.execute("SELECT DISTINCT topic FROM aptitude_questions WHERE category='Quantitative'");
    res.render('aptitude_topics', { topics, user: req.session.user });
});
app.get('/reasoning-topics', requireLogin, async (req, res) => {
    const [topics] = await db.execute("SELECT DISTINCT topic FROM aptitude_questions WHERE category='Logical'");
    res.render('reasoning_topics', { topics, user: req.session.user });
});

// 🔥 ఇవే నీ బటన్స్ కి కావాల్సిన రీడైరెక్ట్ లింక్స్ (FIX)
app.get('/aptitude/:topic', requireLogin, (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/reasoning/:topic', requireLogin, (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));

// PRACTICE ENGINE (LIMIT 30 QUESTIONS)
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topicName = decodeURIComponent(req.params.topic);
    const userId = req.session.user.id;
    try {
        const [done] = await db.execute('SELECT question_id FROM user_progress WHERE user_id = ?', [userId]);
        const doneIds = done.map(row => row.question_id);
        let query, params;
        if (doneIds.length > 0) {
            const placeholders = doneIds.map(() => '?').join(',');
            query = `SELECT * FROM aptitude_questions WHERE topic = ? AND id NOT IN (${placeholders}) ORDER BY RAND() LIMIT 30`;
            params = [topicName, ...doneIds];
        } else {
            query = `SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 30`;
            params = [topicName];
        }
        const [questions] = await db.execute(query, params);
        if (questions.length === 0) {
            return res.send(`<h2>No more questions! Run <a href="/load-final-master">/load-final-master</a> to reset.</h2>`);
        }
        res.render('mocktest', { questions, user: req.session.user, topic: topicName });
    } catch (err) { res.send(err.message); }
});

app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    let score = 0, total = 0, reviewData = [];
    for (const key in userAnswers) {
        if (key.startsWith('q')) {
            const qId = key.substring(1);
            const [q] = await db.execute('SELECT * FROM aptitude_questions WHERE id=?', [qId]);
            if(q.length > 0) {
                const isCorrect = q[0].correct_option === userAnswers[key];
                if(isCorrect) score++;
                total++;
                await db.execute('INSERT IGNORE INTO user_progress (user_id, question_id, topic) VALUES (?, ?, ?)', [req.session.user.id, qId, q[0].topic]);
                reviewData.push({ q: q[0].question, userAns: userAnswers[key], correctAns: q[0].correct_option, explanation: q[0].explanation, isCorrect });
            }
        }
    }
    await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', [req.session.user.id, score, total, req.body.topic_name || "Quiz"]);
    res.render('result', { score, total, reviewData, user: req.session.user });
});

// =========================================================================
// 🔥 THE MASTER LOADER (30+ QUESTIONS FOR ALL 21 TOPICS)
// =========================================================================
app.get('/load-final-master', async (req, res) => {
    try {
        await db.query("TRUNCATE TABLE aptitude_questions");
        await db.query("DELETE FROM user_progress");

        const aptTopics = ['Percentages', 'Profit & Loss', 'Time & Work', 'Probability', 'Averages', 'HCF & LCM', 'Trains', 'Boats & Streams', 'Simple Interest', 'Ratio & Proportion', 'Ages'];
        const logicTopics = ['Blood Relations', 'Number Series', 'Coding-Decoding', 'Syllogism', 'Seating Arrangement', 'Direction Sense', 'Clocks & Calendars', 'Analogy', 'Data Sufficiency', 'Logic Puzzles'];

        for (let topic of aptTopics) {
            for (let i = 1; i <= 35; i++) {
                await db.execute(`INSERT INTO aptitude_questions (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
                VALUES ('Quantitative', ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [topic, `${topic} Question #${i}: Based on standard placement rules.`, `Option A`, `Option B`, `Option C`, `Option D`, 'A', `Shortcut for ${topic}`]);
            }
        }

        for (let topic of logicTopics) {
            for (let i = 1; i <= 35; i++) {
                await db.execute(`INSERT INTO aptitude_questions (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
                VALUES ('Logical', ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [topic, `${topic} Puzzle #${i}: Determine the correct logic.`, `1`, `2`, `3`, `4`, 'B', `Logic for ${topic}`]);
            }
        }

        res.send("<h1>✅ CONFORMED: 700+ QUESTIONS LOADED!</h1><a href='/'>Go Home</a>");
    } catch(err) { res.send(err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));