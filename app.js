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
                    <h2>Topic '${topic}' is empty!</h2>
                    <br>
                    <a href="/fix-questions" style="background:green; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-size:20px;">CLICK TO FIX QUESTIONS</a>
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
// 🔥 FINAL FIX: EXACT TOPIC LOGIC (NO MORE WRONG QUESTIONS)
// =============================================================
app.get('/fix-questions', async (req, res) => {
    try {
        await db.query("TRUNCATE TABLE aptitude_questions"); 

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // EXACT NAMES FROM YOUR SCREENSHOT
        const topics = [
            'Percentages', 'Profit & Loss', 'Time & Work', 'Probability', 'Averages',
            'HCF & LCM', 'Trains', 'Boats & Streams', 'Simple Interest', 'Ratio & Proportion', 'Ages'
        ];

        for (let t of topics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", optA="", optB="", optC="", optD="", ans="A";
                let n1 = i * 10;
                let n2 = i + 5;

                // --- LOGIC FOR EACH TOPIC ---
                
                if (t === 'Percentages') {
                    let res = (n2 / 100) * n1;
                    qText = `What is ${n2}% of ${n1}?`;
                    optA = `${res}`; optB = `${res+10}`; optC = `${res-5}`; optD = `${res*2}`;
                } 
                else if (t === 'Profit & Loss') {
                    let cp = n1 * 10; let p = 20; let sp = cp + (cp*p/100);
                    qText = `CP is ${cp}, Profit is ${p}%. Find Selling Price.`;
                    optA = `${sp}`; optB = `${cp}`; optC = `${sp-10}`; optD = `${sp+20}`;
                }
                else if (t === 'Time & Work') {
                    let d1 = 10; let d2 = 15;
                    qText = `A does work in ${d1} days, B in ${d2} days. Together?`;
                    optA = `6 days`; optB = `8 days`; optC = `12 days`; optD = `5 days`;
                }
                else if (t === 'HCF & LCM') {
                    // Logic: LCM of (12, 18) -> 36. HCF -> 6
                    let numA = 12 * i; let numB = 18 * i;
                    qText = `Find the HCF of ${numA} and ${numB}.`;
                    optA = `${6*i}`; optB = `${numA}`; optC = `${numB}`; optD = `1`;
                }
                else if (t === 'Averages') {
                    // Logic: Avg of 5 numbers is X. Sum = 5*X
                    let avg = n1; 
                    qText = `The average of 5 numbers is ${avg}. What is the sum?`;
                    optA = `${avg*5}`; optB = `${avg}`; optC = `${avg*2}`; optD = `${avg+5}`;
                }
                else if (t === 'Trains') {
                    let length = n1 * 10; let speed = 36; // 36kmph = 10m/s
                    let time = length / 10;
                    qText = `Train of length ${length}m moving at ${speed}kmph crosses a pole in?`;
                    optA = `${time} sec`; optB = `${time+5} sec`; optC = `${time-2} sec`; optD = `10 sec`;
                }
                else if (t === 'Boats & Streams') {
                    let b = 10 + i; let s = 5;
                    qText = `Boat speed ${b} kmph, Stream ${s} kmph. Find Downstream speed.`;
                    optA = `${b+s} kmph`; optB = `${b-s} kmph`; optC = `${b} kmph`; optD = `${s} kmph`;
                }
                else if (t === 'Simple Interest') {
                    let p = n1 * 100; let r = 10; let time = 2;
                    let si = (p*r*time)/100;
                    qText = `Find SI on ${p} at ${r}% for ${time} years.`;
                    optA = `${si}`; optB = `${si+100}`; optC = `${p}`; optD = `${si-50}`;
                }
                else if (t === 'Ratio & Proportion') {
                    qText = `If A:B = 2:3 and B:C = 4:5, find A:B:C`;
                    optA = `8:12:15`; optB = `2:3:5`; optC = `4:6:9`; optD = `None`;
                }
                else if (t === 'Ages') {
                    qText = `A is ${n1} years old. B is twice as old as A. Find B's age.`;
                    optA = `${n1*2}`; optB = `${n1}`; optC = `${n1+5}`; optD = `${n1+10}`;
                }
                else {
                    // Probability Fallback
                    qText = `Probability of getting a Head when tossing a coin?`;
                    optA = `1/2`; optB = `1/4`; optC = `1`; optD = `0`;
                }

                await addQ('Quantitative', t, qText, optA, optB, optC, optD, ans, "Formula Applied");
            }
        }

        res.send(`<h1>✅ QUESTIONS FIXED!</h1><p>Check HCF, Averages, etc. They are now CORRECT.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));