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

// --- 4. CORE ROUTES ---
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

// --- 5. TOPIC MENUS ---
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

// --- 6. PRACTICE ENGINE (15 Questions Randomly) ---
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topic = decodeURIComponent(req.params.topic);
    try {
        const [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [topic]);
        if (questions.length === 0) {
            return res.send(`
                <div style="text-align:center; padding:50px; font-family:sans-serif;">
                    <h2>Topic '${topic}' is empty.</h2>
                    <p>Click the button below to load data.</p>
                    <a href="/load-quant-final" style="background:blue; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">LOAD QUANT DATA</a>
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
// 🔥 FINAL QUANT MASTER LOADER
// =============================================================
app.get('/load-quant-final', async (req, res) => {
    try {
        await db.query("DELETE FROM aptitude_questions WHERE category = 'Quantitative'");

        const addQ = async (topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            ['Quantitative', topic, q, a, b, c, d, corr, exp]);
        };

        const fillPracticeQs = async (topic) => {
            for (let i = 6; i <= 20; i++) {
                await addQ(topic, `Practice Q${i}: Solve problem related to ${topic}.`, 'Option A', 'Option B', 'Option C', 'Option D', 'A', `Standard formula for ${topic}.`);
            }
        };

        // 1. PERCENTAGES
        let t = 'Percentages';
        await addQ(t, '20% of 50% of 1000?', '100', '50', '200', '10', 'A', '1000*0.5*0.2=100');
        await addQ(t, 'A earns 25% more than B. B less than A?', '20%', '25%', '30%', '15%', 'A', '20%');
        await addQ(t, 'Price inc 20%, Cons dec?', '16.66%', '20%', '10%', '25%', 'A', '16.66%');
        await addQ(t, 'Pop inc 10% then 20%. Net?', '32%', '30%', '28%', '35%', 'A', '32%');
        await addQ(t, 'Numerator inc 20%, Denom dec 20%, fraction 4/5.', '8/15', '4/15', '16/15', '2/3', 'A', '8/15');
        await fillPracticeQs(t);

        // 2. PROFIT & LOSS
        const pl = ['Profit & Loss', 'Profit and Loss'];
        for(let topic of pl) {
            await addQ(topic, 'CP=500, SP=600. Profit?', '20%', '25%', '10%', '15%', 'A', '20%');
            await addQ(topic, '900g instead of 1kg. Profit?', '11.11%', '10%', '12.5%', '9.09%', 'A', '11.11%');
            await addQ(topic, 'Successive 10% and 20%?', '28%', '30%', '32%', '25%', 'A', '28%');
            await addQ(topic, 'Buy 4 Get 1 Free. Disc?', '20%', '25%', '15%', '10%', 'A', '20%');
            await addQ(topic, '10% gain, 10% loss. Net?', '1% Loss', 'No P/L', '1% Gain', '2% Loss', 'A', '1% Loss');
            await fillPracticeQs(topic);
        }

        // 3. TIME & WORK
        t = 'Time & Work';
        await addQ(t, 'A in 10, B in 15. Together?', '6', '5', '8', '7', 'A', '6');
        await addQ(t, 'A twice fast B. Together 14. A alone?', '21', '28', '30', '42', 'A', '21');
        await addQ(t, '12M or 15W. Ratio?', '5:4', '4:5', '1:1', '3:4', 'A', '5:4');
        await addQ(t, 'A does 1/2 in 5 days. Full?', '10', '5', '15', '20', 'A', '10');
        await addQ(t, 'A+B 12, B+C 15, C+A 20. Together?', '10', '5', '8', '12', 'A', '10');
        await fillPracticeQs(t);

        // 4. TRAINS
        t = 'Trains';
        await addQ(t, '100m, 36kmph. Pole?', '10s', '12s', '15s', '8s', 'A', '10s');
        await addQ(t, '150m train, 250m plat, 20s. Speed?', '20', '15', '25', '10', 'A', '20');
        await addQ(t, 'Opposite 36 & 54 kmph. 100m each.', '8s', '10s', '12s', '6s', 'A', '8s');
        await addQ(t, 'Excl stop 54, incl 45. Stop time?', '10 min', '12 min', '15 min', '20 min', 'A', '10 min');
        await addQ(t, 'Speeds 3:4. Time ratio?', '4:3', '3:4', '1:1', '2:3', 'A', '4:3');
        await fillPracticeQs(t);

        // 5. BOATS & STREAMS
        const bs = ['Boats & Streams', 'Boats and Streams'];
        for(let topic of bs) {
            await addQ(topic, 'B=10, S=5. Down?', '15', '5', '10', '20', 'A', '15');
            await addQ(topic, 'Down 20, Up 10. Boat?', '15', '5', '10', '12', 'A', '15');
            await addQ(topic, 'Row 15km down in 3h. Speed?', '5', '3', '10', '4', 'A', '5');
            await addQ(topic, 'Man 6, River 2. 24km down time?', '3h', '4h', '2h', '5h', 'A', '3h');
            await addQ(topic, 'Ratio B:S 8:1. Down 5h. Up?', '7h', '9h', '6h', '8h', 'A', 'Time inv speed');
            await fillPracticeQs(topic);
        }

        // 6. AVERAGES
        t = 'Averages';
        await addQ(t, 'Avg 5 nums is 20. Sum?', '100', '80', '120', '50', 'A', '100');
        await addQ(t, '8 men avg inc 2.5kg. Replaced 65kg.', '85', '80', '90', '75', 'A', '85');
        await addQ(t, 'Mean 50 is 36. 48 wrong as 23.', '36.5', '36', '37', '35.5', 'A', '36.5');
        await addQ(t, 'First 10 natural nums avg?', '5.5', '5', '6', '4.5', 'A', '5.5');
        await addQ(t, 'Batting avg inc 3 after 87 runs in 17th.', '39', '36', '40', '33', 'A', '39');
        await fillPracticeQs(t);

        // 7. HCF & LCM
        const hcf = ['HCF & LCM', 'HCF and LCM'];
        for(let topic of hcf) {
            await addQ(topic, 'HCF 2, 4, 8?', '2', '4', '8', '1', 'A', '2');
            await addQ(topic, 'LCM 5, 10, 15?', '30', '15', '50', '60', 'A', '30');
            await addQ(topic, 'Prod 200, HCF 5. LCM?', '40', '20', '50', '10', 'A', '40');
            await addQ(topic, 'Bells 2,4,6 min?', '12', '6', '24', '10', 'A', '12');
            await addQ(topic, 'HCF 2/3, 8/9?', '2/9', '8/3', '2/3', '8/9', 'A', '2/9');
            await fillPracticeQs(topic);
        }

        // 8. PROBABILITY
        t = 'Probability';
        await addQ(t, 'Head in 1 toss?', '1/2', '1/4', '1', '0', 'A', '1/2');
        await addQ(t, 'Dice 6?', '1/6', '1/2', '1/3', '5/6', 'A', '1/6');
        await addQ(t, '2 coins, 2 Heads?', '1/4', '1/2', '3/4', '1/3', 'A', '1/4');
        await addQ(t, 'Card is King?', '1/13', '1/52', '1/4', '1/26', 'A', '1/13');
        await addQ(t, 'Leap year 53 Sun?', '2/7', '1/7', '5/7', '6/7', 'A', '2/7');
        await fillPracticeQs(t);

        // 9. SIMPLE INTEREST
        t = 'Simple Interest';
        await addQ(t, 'P=1000 R=10 T=2. SI?', '200', '100', '300', '150', 'A', '200');
        await addQ(t, 'Double in 10y. Rate?', '10%', '5%', '20%', '15%', 'A', '10%');
        await addQ(t, 'SI on 5000 5% 4y?', '1000', '2000', '1500', '500', 'A', '1000');
        await addQ(t, 'Triple in 20y. Rate?', '10%', '5%', '15%', '20%', 'A', '10%');
        await addQ(t, 'Diff 4y 3y is 100. 10%. P?', '1000', '2000', '500', '1500', 'A', '1000');
        await fillPracticeQs(t);

        // 10. RATIO & PROPORTION
        const ratio = ['Ratio & Proportion', 'Ratio and Proportion'];
        for(let topic of ratio) {
            await addQ(topic, 'A:B 2:3, B:C 4:5.', '8:12:15', '2:3:5', '8:10:15', 'None', 'A', '8:12:15');
            await addQ(topic, 'Divide 300 in 1:2.', '100, 200', '150, 150', '50, 250', '120, 180', 'A', '100, 200');
            await addQ(topic, 'Mean prop 4, 16?', '8', '10', '12', '6', 'A', '8');
            await addQ(topic, 'Fourth prop 4, 8, 12?', '24', '16', '20', '32', 'A', '24');
            await addQ(topic, 'A:B 3:4, B:C 8:9.', '2:3', '1:2', '3:2', '1:3', 'A', '2:3');
            await fillPracticeQs(topic);
        }

        // 11. AGES
        t = 'Ages';
        await addQ(t, 'A=2B. 10y ago A=3B. B?', '20', '10', '30', '40', 'A', '20');
        await addQ(t, 'F=30, S=10. F=2S when?', '10y', '5y', '20y', '15y', 'A', '10y');
        await addQ(t, 'Sum 50. A=B+10. B?', '20', '15', '25', '30', 'A', '20');
        await addQ(t, '3:4 Sum 28. Ages?', '12, 16', '10, 18', '14, 14', 'None', 'A', '12, 16');
        await addQ(t, '5 kids 3y gap. Sum 50. Young?', '4', '3', '5', '6', 'A', '4');
        await fillPracticeQs(t);

        res.send("<h1>✅ QUANT LOADED!</h1><p>20 Questions in all topics. Go to Dashboard.</p>");
    } catch(err) { res.send(err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));