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

// --- 3. ROUTES ---
const requireLogin = (req, res, next) => {
    if (req.session.user) { next(); } else { res.redirect('/login'); }
};

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

// DASHBOARD
app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores });
    } catch (err) { res.render('dashboard', { user: req.session.user, scores: [] }); }
});

// TOPICS
app.get('/aptitude-topics', requireLogin, (req, res) => res.render('aptitude_topics', { user: req.session.user }));
app.get('/reasoning-topics', requireLogin, (req, res) => res.render('reasoning_topics', { user: req.session.user }));
app.get('/english-topics', requireLogin, (req, res) => res.render('english_topics', { user: req.session.user }));
app.get('/coding', requireLogin, (req, res) => res.render('coding_topics', { user: req.session.user }));

// PRACTICE REDIRECTS
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.post('/coding/practice', requireLogin, (req, res) => res.redirect(`/practice/${encodeURIComponent(req.body.topic)}`));

// PRACTICE ENGINE (15 Questions Randomly)
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topic = decodeURIComponent(req.params.topic);
    try {
        const [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [topic]);
        if (questions.length === 0) {
            return res.send(`<h2>Topic '${topic}' is empty. <a href="/load-quant-batch-1">CLICK TO LOAD BATCH 1</a></h2>`);
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
    const [rankings] = await db.query("SELECT u.username, MAX(m.score) as high_score FROM mock_results m JOIN users u ON m.user_id = u.id GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10");
    res.render('leaderboard', { user: req.session.user, rankings });
});
app.get('/interview-prep', requireLogin, (req, res) => res.render('interview', { user: req.session.user }));
app.get('/resume-upload', requireLogin, async (req, res) => {
    const [history] = await db.execute('SELECT * FROM user_resumes WHERE email = ?', [req.session.user.email]);
    res.render('resume', { msg: null, user: req.session.user, history });
});
const upload = multer({ dest: 'public/uploads/' });
app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    if(req.file) await db.execute('INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)', ['User', req.session.user.email, req.file.path, 80]);
    res.redirect('/resume-upload');
});

// =============================================================
// 🔥 QUANT BATCH 1 LOADER (Percentages, P&L, Time&Work, Trains, Averages)
// =============================================================
app.get('/load-quant-batch-1', async (req, res) => {
    try {
        const topicsToClean = ['Percentages', 'Profit & Loss', 'Time & Work', 'Trains', 'Averages'];
        await db.query(`DELETE FROM aptitude_questions WHERE topic IN (?)`, [topicsToClean]);

        const addQ = async (topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            ['Quantitative', topic, q, a, b, c, d, corr, exp]);
        };

        // PERCENTAGES
        await addQ('Percentages', 'Two numbers are 20% and 50% more than a third number. The ratio of the two numbers is?', '2:5', '3:5', '4:5', '6:7', 'C', 'Ratio = 120:150 = 4:5. \n⚡ SHORTCUT: Direct Ratio 120:150.');
        await addQ('Percentages', 'If A earns 25% more than B, how much percent does B earn less than A?', '20%', '25%', '15%', '30%', 'A', 'Formula: [R / (100+R)] * 100 => 20%.\n⚡ SHORTCUT: 1/4 inc = 1/5 dec.');
        await addQ('Percentages', 'Price of sugar rises by 20%. By how much % should consumption be reduced to keep expenditure same?', '20%', '16.66%', '25%', '10%', 'B', '20/120 * 100 = 16.66%.\n⚡ SHORTCUT: Price 5:6 -> Cons 6:5.');
        await addQ('Percentages', 'Population increases 10% then 20%. Net effect?', '32%', '30%', '28%', '35%', 'A', '10+20+(200/100) = 32%.\n⚡ SHORTCUT: Successive % formula.');
        await addQ('Percentages', '80% passed English, 85% Maths, 75% both. Fail both?', '10%', '5%', '15%', '20%', 'A', '100 - (80+85-75) = 10%.\n⚡ SHORTCUT: Venn Diagram.');
        await addQ('Percentages', 'What is 20% of 50% of 1000?', '100', '50', '200', '10', 'A', '1000 * 0.5 * 0.2 = 100.');
        
        // PROFIT & LOSS
        await addQ('Profit & Loss', 'CP=500, SP=600. Profit %?', '20%', '25%', '10%', '15%', 'A', '100/500 * 100 = 20%.');
        await addQ('Profit & Loss', 'Dishonest dealer uses 900g instead of 1kg. Profit %?', '11.11%', '10%', '9.09%', '12%', 'A', '100/900 * 100 = 11.11%.\n⚡ SHORTCUT: Error/True-Error.');
        await addQ('Profit & Loss', 'Sold two items 99 each. 10% gain, 10% loss. Net?', '1% Loss', 'No P/L', '1% Gain', '2% Loss', 'A', 'Always Loss: x^2/100 = 1%.');
        await addQ('Profit & Loss', 'Successive discounts 10% and 20%?', '28%', '30%', '32%', '25%', 'A', '10+20-2 = 28%.\n⚡ SHORTCUT: 100->90->72.');
        await addQ('Profit & Loss', 'Buy 4 Get 1 Free. Discount %?', '20%', '25%', '15%', '10%', 'A', '1/5 * 100 = 20%.\n⚡ SHORTCUT: Free/Total.');

        // TRAINS
        await addQ('Trains', 'Train 100m, 36kmph. Pole crossing time?', '10s', '12s', '15s', '8s', 'A', '36kmph=10m/s. 100/10=10s.');
        await addQ('Trains', 'Train 150m crosses 250m platform in 20s. Speed?', '20 m/s', '15 m/s', '25 m/s', '10 m/s', 'A', '400/20 = 20m/s.\n⚡ SHORTCUT: Total Dist/Time.');
        await addQ('Trains', 'Two trains 100m each opposite 36kmph & 54kmph. Time?', '8s', '10s', '12s', '15s', 'A', 'Rel Speed 90kmph=25m/s. 200/25=8s.');
        
        // TIME & WORK
        await addQ('Time & Work', 'A in 10, B in 15. Together?', '6 days', '5 days', '8 days', '7 days', 'A', '150/25 = 6.\n⚡ SHORTCUT: LCM Method.');
        await addQ('Time & Work', 'A is twice as good as B. Together 14 days. A alone?', '21 days', '28 days', '30 days', '42 days', 'A', 'Eff 2:1. Total 3. Work=42. A=42/2=21.');
        await addQ('Time & Work', '12 Men or 15 Women. Ratio?', '5:4', '4:5', '1:1', '3:4', 'A', '12M=15W => M/W = 5/4.');

        // AVERAGES
        await addQ('Averages', 'Avg of 8 men increases by 2.5kg when 65kg man replaced. New man?', '85 kg', '80 kg', '90 kg', '75 kg', 'A', '65 + (8*2.5) = 85.\n⚡ SHORTCUT: Old + (N*Diff).');
        await addQ('Averages', 'Avg of first 5 natural numbers?', '3', '2.5', '3.5', '2', 'A', '(1+5)/2 = 3.');

        res.send("<h1>✅ BATCH 1 LOADED!</h1><p>Percentages, P&L, Trains, Time&Work, Averages Filled.</p><a href='/'>Go Dashboard</a>");
    } catch(err) { res.send(err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));