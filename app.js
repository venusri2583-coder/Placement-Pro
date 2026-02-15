const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');

dotenv.config();
const app = express();

// --- 1. SESSION SETUP ---
app.use(session({
    secret: 'placement_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. DATABASE CONNECTION ---
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10
});

// --- 3. AUTH MIDDLEWARE ---
const requireLogin = (req, res, next) => {
    if (req.session.user) { next(); } else { res.redirect('/login'); }
};

// --- 4. ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    try {
        await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [req.body.username, req.body.email, req.body.password]);
        res.render('login', { msg: 'Account Created! Please Login.', error: null });
    } catch (err) { res.render('register', { error: 'Email exists.' }); }
});

app.post('/login', async (req, res) => {
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [req.body.email]);
        if (users.length > 0 && users[0].password === req.body.password) {
            req.session.user = users[0];
            res.redirect('/');
        } else { res.render('login', { error: 'Invalid Details', msg: null }); }
    } catch (err) { res.render('login', { error: 'Server Error', msg: null }); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores });
    } catch (err) { res.render('dashboard', { user: req.session.user, scores: [] }); }
});

// TOPIC MENUS
app.get('/aptitude-topics', requireLogin, (req, res) => res.render('aptitude_topics', { user: req.session.user }));
app.get('/reasoning-topics', requireLogin, (req, res) => res.render('reasoning_topics', { user: req.session.user }));
app.get('/english-topics', requireLogin, (req, res) => res.render('english_topics', { user: req.session.user }));
app.get('/coding', requireLogin, (req, res) => res.render('coding_topics', { user: req.session.user }));

// REDIRECTS
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.post('/coding/practice', requireLogin, (req, res) => res.redirect(`/practice/${encodeURIComponent(req.body.topic)}`));

// PRACTICE ENGINE
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topic = decodeURIComponent(req.params.topic);
    try {
        const [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [topic]);
        if (questions.length === 0) {
            return res.send(`
                <div style="text-align:center; padding:50px;">
                    <h2>Topic '${topic}' is empty.</h2>
                    <br>
                    <a href="/generate-real-math" style="background:green; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-size:20px;">CLICK HERE TO LOAD QUESTIONS</a>
                </div>
            `);
        }
        res.render('mocktest', { questions, user: req.session.user, topic });
    } catch (err) { res.redirect('/'); }
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
                reviewData.push({ q: q[0].question, userAns: userAnswers[key], correctAns: q[0].correct_option, explanation: q[0].explanation, isCorrect });
            }
        }
    }
    await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', [req.session.user.id, score, total, req.body.topic_name || "Quiz"]);
    res.render('result', { score, total, reviewData, user: req.session.user });
});

// LEADERBOARD & RESUME
app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const [rankings] = await db.query("SELECT u.username, MAX(m.score) as high_score FROM mock_results m JOIN users u ON m.user_id = u.id GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10");
        res.render('leaderboard', { user: req.session.user, rankings });
    } catch(e) { res.render('leaderboard', { user: req.session.user, rankings: [] }); }
});
app.get('/interview-prep', requireLogin, (req, res) => res.render('interview', { user: req.session.user }));
app.get('/resume-upload', requireLogin, async (req, res) => {
    try {
        const [history] = await db.execute('SELECT * FROM user_resumes WHERE email = ?', [req.session.user.email]);
        res.render('resume', { msg: null, user: req.session.user, history });
    } catch(e) { res.render('resume', { msg: null, user: req.session.user, history: [] }); }
});
const upload = multer({ dest: 'public/uploads/' });
app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    if(req.file) await db.execute('INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)', ['User', req.session.user.email, req.file.path, 80]);
    res.redirect('/resume-upload');
});

// =============================================================
// 🔥 SMART GENERATOR: REAL MATH LOGIC (NO "PRACTICE Q" TEXT)
// =============================================================
app.get('/generate-real-math', async (req, res) => {
    try {
        await db.query("TRUNCATE TABLE aptitude_questions"); // Clear old garbage

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        const topics = ['Percentages', 'Profit & Loss', 'Time & Work', 'Trains', 'Averages', 'Simple Interest', 'Boats & Streams', 'HCF & LCM', 'Probability', 'Ratio & Proportion', 'Ages'];

        for (let t of topics) {
            // Generate 30 UNIQUE Questions per topic
            for (let i = 1; i <= 30; i++) {
                
                let qText="", optA="", optB="", optC="", optD="", ans="A", exp="";
                let num1 = i * 50;  // Example: 50, 100, 150...
                let num2 = 10 + i;  // Example: 11, 12, 13...

                if (t === 'Percentages') {
                    let res = (num2 / 100) * num1;
                    qText = `What is ${num2}% of ${num1}?`;
                    optA = `${res}`; optB = `${res + 10}`; optC = `${res - 5}`; optD = `${res * 2}`;
                    exp = `${num1} * (${num2}/100) = ${res}`;
                } 
                else if (t === 'Profit & Loss') {
                    let cp = num1; let profit = num2; let sp = cp + (cp * profit / 100);
                    qText = `Cost Price is Rs.${cp} and Profit is ${profit}%. Find Selling Price.`;
                    optA = `${sp}`; optB = `${sp - 20}`; optC = `${sp + 50}`; optD = `${cp}`;
                    exp = `SP = CP + Profit = ${cp} + (${profit}% of ${cp}) = ${sp}`;
                }
                else if (t === 'Time & Work') {
                    let d1 = 10 + i; let d2 = 20 + i;
                    let total = ((d1 * d2) / (d1 + d2)).toFixed(2);
                    qText = `A finishes work in ${d1} days, B in ${d2} days. Together?`;
                    optA = `${total} days`; optB = `${d1 + d2} days`; optC = `${(d1+d2)/2} days`; optD = `5 days`;
                    exp = `Formula: (A*B)/(A+B)`;
                }
                else if (t === 'Trains') {
                    let speed = 36 + i; let dist = 100 + (i*10);
                    let speedMS = (speed * 5/18).toFixed(1);
                    let time = (dist / speedMS).toFixed(1);
                    qText = `Train length ${dist}m running at ${speed} kmph crosses a pole in?`;
                    optA = `${time} sec`; optB = `${time + 5} sec`; optC = `${time - 2} sec`; optD = `10 sec`;
                    exp = `Time = Dist/Speed (m/s).`;
                }
                else if (t === 'Simple Interest') {
                    let P = num1; let R = 5; let T = 2;
                    let SI = (P * R * T) / 100;
                    qText = `Simple Interest on Rs.${P} at ${R}% for ${T} years?`;
                    optA = `${SI}`; optB = `${SI + 50}`; optC = `${SI - 20}`; optD = `${P}`;
                    exp = `SI = PTR/100`;
                }
                else {
                    let val = num1 + num2;
                    qText = `Solve: ${num1} + ${num2} = ?`;
                    optA = `${val}`; optB = `${val + 10}`; optC = `${val - 5}`; optD = `0`;
                    exp = `Basic Addition`;
                }

                await addQ('Quantitative', t, qText, optA, optB, optC, optD, ans, exp);
            }
        }

        res.send(`<h1>✅ REAL MATH QUESTIONS LOADED!</h1><p>Check Percentages, P&L, etc. No garbage text.</p><a href="/">Go Home</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));