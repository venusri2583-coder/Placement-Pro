const express = require('express');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const multer = require('multer');
const session = require('express-session');

dotenv.config();
const app = express();

// --- SESSION SETUP ---
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

// --- DATABASE CONNECTION ---
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

const requireLogin = (req, res, next) => {
    if (req.session.user) { next(); } else { res.redirect('/login'); }
};

// --- ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null, msg: null }));
app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', async (req, res) => {
    try {
        await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [req.body.username, req.body.email, req.body.password]);
        res.render('login', { msg: 'Account Created!', error: null });
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

// --- DASHBOARD ---
app.get('/', requireLogin, async (req, res) => {
    try {
        const [scores] = await db.execute('SELECT * FROM mock_results WHERE user_id = ? ORDER BY test_date DESC', [req.session.user.id]);
        res.render('dashboard', { user: req.session.user, scores });
    } catch (err) { res.render('dashboard', { user: req.session.user, scores: [] }); }
});

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

// --- PRACTICE ENGINE ---
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topic = decodeURIComponent(req.params.topic);
    try {
        let [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [topic]);
        
        if (questions.length === 0) {
            let altTopic = topic;
            if (topic === 'Problems on Trains') altTopic = 'Trains';
            else if (topic === 'Trains') altTopic = 'Problems on Trains';
            else if (topic.includes('&')) altTopic = topic.replace('&', 'and');
            else if (topic.includes('and')) altTopic = topic.replace('and', '&');
            
            [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [altTopic]);
        }

        if (questions.length === 0) {
            return res.send(`
                <div style="text-align:center; padding:50px;">
                    <h2 style="color:red;">Topic '${topic}' is empty!</h2>
                    <br>
                    <a href="/shuffle-data-final" style="background:green; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-size:20px;">CLICK TO LOAD SHUFFLED QUESTIONS</a>
                </div>
            `);
        }
        res.render('mocktest', { questions, user: req.session.user, topic });
    } catch (err) { res.redirect('/'); }
});

// --- SMART GRADING ---
app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    let score = 0, total = 0, reviewData = [];
    for (const key in userAnswers) {
        if (key.startsWith('q')) {
            const qId = key.substring(1);
            const [rows] = await db.execute('SELECT * FROM aptitude_questions WHERE id=?', [qId]);
            if(rows.length > 0) {
                const dbQ = rows[0];
                const userVal = userAnswers[key].toString().trim(); 
                const correctOpt = dbQ.correct_option.trim(); 
                const correctVal = dbQ[`option_${correctOpt.toLowerCase()}`].toString().trim(); 
                
                let isCorrect = (userVal === correctOpt) || (userVal == correctVal);
                if(isCorrect) score++;
                total++;
                
                reviewData.push({ 
                    q: dbQ.question, 
                    userAns: userVal, 
                    correctAns: `${correctOpt}) ${correctVal}`, 
                    explanation: dbQ.explanation, 
                    isCorrect 
                });
            }
        }
    }
    await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', [req.session.user.id, score, total, req.body.topic_name || "Quiz"]);
    res.render('result', { score, total, reviewData, user: req.session.user });
});

app.get('/leaderboard', requireLogin, async (req, res) => {
    try {
        const [rankings] = await db.query("SELECT u.username, MAX(m.score) as high_score FROM mock_results m JOIN users u ON m.user_id = u.id GROUP BY u.id, u.username ORDER BY high_score DESC LIMIT 10");
        res.render('leaderboard', { user: req.session.user, rankings });
    } catch(e) { res.render('leaderboard', { user: req.session.user, rankings: [] }); }
});
app.get('/interview-prep', requireLogin, (req, res) => res.render('interview', { user: req.session.user }));
app.get('/resume-upload', requireLogin, async (req, res) => { res.render('resume', { msg: null, user: req.session.user, history: [] }); });
const upload = multer({ dest: 'public/uploads/' });
app.post('/upload-resume', requireLogin, upload.single('resume'), async (req, res) => {
    if(req.file) await db.execute('INSERT INTO user_resumes (full_name, email, file_path, ats_score) VALUES (?, ?, ?, ?)', ['User', req.session.user.email, req.file.path, 80]);
    res.redirect('/resume-upload');
});

// =============================================================
// 🔥 SHUFFLE DATA GENERATOR (Random A, B, C, D)
// =============================================================
app.get('/shuffle-data-final', async (req, res) => {
    try {
        await db.query("TRUNCATE TABLE aptitude_questions");

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle array
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        const quant = [
            'Percentages', 'Profit & Loss', 'Profit and Loss', 'Time & Work', 'Time and Work', 
            'Trains', 'Problems on Trains', 'Boats & Streams', 'Boats and Streams', 'Averages', 
            'HCF & LCM', 'HCF and LCM', 'Simple Interest', 'Ratio & Proportion', 'Ratio and Proportion', 
            'Ages', 'Problems on Ages', 'Probability'
        ];

        for (let t of quant) {
            for (let i = 1; i <= 20; i++) {
                let n1 = i * 10, n2 = i + 2;
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";

                // 1. Generate Question & Correct Answer
                if (t === 'Percentages') { 
                    qText = `What is ${n2}% of ${n1}?`; ansVal = `${n1*n2/100}`; w1=`${n1}`; w2=`0`; w3=`100`; explanation=`${n1} * ${n2}/100`;
                }
                else if (t.includes('Profit')) { 
                    qText = `CP = ${n1*10}, Profit = 20%. Find SP.`; ansVal=`${n1*12}`; w1=`${n1*10}`; w2=`${n1*8}`; w3=`0`; explanation=`SP = CP * 1.2`;
                }
                else if (t.includes('Time')) { 
                    qText = `A in ${n1} days, B in ${n1*2}. Together?`; ansVal=`${(n1*n1*2)/(n1*3)}`; w1=`${n1}`; w2=`${n1+5}`; w3=`1`; explanation=`(A*B)/(A+B)`;
                }
                else if (t.includes('HCF')) { 
                    qText = `HCF of ${n1} and ${n1*2}.`; ansVal=`${n1}`; w1=`1`; w2=`${n1*2}`; w3=`0`; explanation=`Highest common factor is ${n1}`;
                }
                else if (t === 'Averages') { 
                    qText = `Avg of 10, 20, 30 and ${n1}?`; ansVal=`${(60+n1)/4}`; w1=`${n1}`; w2=`20`; w3=`0`; explanation=`Sum/Count`;
                }
                else if (t.includes('Trains')) { 
                    qText = `Train ${n1}m at 36kmph crosses pole in?`; ansVal=`${n1/10}s`; w1=`${n1}s`; w2=`10s`; w3=`0`; explanation=`Time = Dist/Speed`;
                }
                else if (t.includes('Boats')) { 
                    qText = `Boat ${n1}kmph, Stream 2kmph. Downstream?`; ansVal=`${n1+2}`; w1=`${n1-2}`; w2=`${n1}`; w3=`2`; explanation=`Down = Boat + Stream`;
                }
                else if (t === 'Simple Interest') {
                    qText = `SI on ${n1*100} at 10% for 2 years?`; ansVal=`${n1*20}`; w1=`${n1*10}`; w2=`${n1}`; w3=`0`; explanation=`PTR/100`;
                }
                else if (t.includes('Ratio')) {
                    qText = `Ratio of ${n1} to ${n1}?`; ansVal=`1:1`; w1=`1:2`; w2=`2:1`; w3=`None`; explanation=`Same numbers ratio is 1:1`;
                }
                else if (t.includes('Ages')) {
                    qText = `A is ${n1}, B is twice A. B's age?`; ansVal=`${n1*2}`; w1=`${n1}`; w2=`${n1+5}`; w3=`0`; explanation=`2 * ${n1}`;
                }
                else if (t === 'Probability') {
                     qText=`Prob of Head in 1 toss?`; ansVal=`1/2`; w1=`1/4`; w2=`0`; w3=`1`; explanation=`1 outcome out of 2`;
                }

                // 2. SHUFFLE OPTIONS
                if(qText) {
                    let opts = [
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ];
                    opts = shuffle(opts); // Randomize positions

                    // 3. Find which position holds the correct answer
                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Quantitative', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }
        res.send(`<h1>✅ DATA SHUFFLED!</h1><p>Questions now have randomized options (A, B, C, D).</p><a href="/">Go to Dashboard</a>`);
    } catch(err) { res.send("Error: " + err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));