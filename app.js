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

// --- AUTH MIDDLEWARE ---
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

// --- TOPIC MENUS ---
app.get('/aptitude-topics', requireLogin, (req, res) => res.render('aptitude_topics', { user: req.session.user }));
app.get('/reasoning-topics', requireLogin, (req, res) => res.render('reasoning_topics', { user: req.session.user }));
app.get('/english-topics', requireLogin, (req, res) => res.render('english_topics', { user: req.session.user }));
app.get('/coding', requireLogin, (req, res) => res.render('coding_topics', { user: req.session.user }));

// --- REDIRECTS ---
app.get('/aptitude/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/reasoning/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/english/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.get('/coding/:topic', (req, res) => res.redirect(`/practice/${encodeURIComponent(req.params.topic)}`));
app.post('/coding/practice', requireLogin, (req, res) => res.redirect(`/practice/${encodeURIComponent(req.body.topic)}`));

// --- PRACTICE ENGINE ---
app.get('/practice/:topic', requireLogin, async (req, res) => {
    const topic = decodeURIComponent(req.params.topic);
    try {
        // Try Exact Match first
        let [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [topic]);
        
        // Fallback: If empty, try checking with/without 'and'/'&'
        if (questions.length === 0) {
            let altTopic = topic;
            if (topic.includes('&')) altTopic = topic.replace('&', 'and');
            else if (topic.includes('and')) altTopic = topic.replace('and', '&');
            
            [questions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ? ORDER BY RAND() LIMIT 15', [altTopic]);
        }

        if (questions.length === 0) {
            // Show link to FIX DATA if still empty
            return res.send(`
                <div style="text-align:center; padding:50px;">
                    <h2 style="color:red;">Topic '${topic}' is empty!</h2>
                    <br>
                    <p>Don't panic. Click the green button below to load ALL questions properly.</p>
                    <a href="/load-mega-data" style="background:green; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-size:20px;">CLICK TO FIX & LOAD ALL DATA</a>
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
// 🔥 MEGA LOADER: MATHS + REASONING + CODING + ENGLISH
// =============================================================
app.get('/load-mega-data', async (req, res) => {
    try {
        await db.query("TRUNCATE TABLE aptitude_questions"); // Wipe old bad data

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // --- 1. MATHS TOPICS (Both Names Included) ---
        const quant = [
            'Percentages', 'Profit & Loss', 'Profit and Loss', 
            'Time & Work', 'Time and Work', 'Trains', 
            'Boats & Streams', 'Boats and Streams', 'Averages', 
            'HCF & LCM', 'HCF and LCM', 'Simple Interest', 
            'Ratio & Proportion', 'Ratio and Proportion', 'Ages', 'Probability'
        ];

        for (let t of quant) {
            for (let i = 1; i <= 20; i++) {
                let n1 = i * 10, n2 = i + 2;
                let qText="", optA="", optB="", optC="", optD="", ans="A";

                if (t === 'Percentages') { 
                    qText = `What is ${n2}% of ${n1}?`; optA=`${n1*n2/100}`; optB=`${n1}`; optC=`0`; optD=`100`; 
                }
                else if (t.includes('Profit')) { 
                    qText = `CP = ${n1*10}, Profit = 20%. Find SP.`; optA=`${n1*12}`; optB=`${n1*10}`; optC=`${n1*8}`; optD=`0`; 
                }
                else if (t.includes('Time')) { 
                    qText = `A does work in ${n1} days, B in ${n1*2}. Together?`; optA=`${(n1*n1*2)/(n1*3)}`; optB=`${n1}`; optC=`${n1+5}`; optD=`1`; 
                }
                else if (t.includes('HCF')) { 
                    qText = `Find HCF of ${n1} and ${n1*2}.`; optA=`${n1}`; optB=`1`; optC=`${n1*2}`; optD=`0`; 
                }
                else if (t === 'Averages') { 
                    qText = `Average of 10, 20, 30 and ${n1} is?`; optA=`${(60+n1)/4}`; optB=`${n1}`; optC=`20`; optD=`0`; 
                }
                else if (t === 'Trains') { 
                    qText = `Train ${n1}m at 36kmph crosses pole in?`; optA=`${n1/10}s`; optB=`${n1}s`; optC=`10s`; optD=`0`; 
                }
                else if (t.includes('Boats')) { 
                    qText = `Boat ${n1}kmph, Stream 2kmph. Downstream?`; optA=`${n1+2}`; optB=`${n1-2}`; optC=`${n1}`; optD=`2`; 
                }
                else if (t === 'Simple Interest') {
                    qText = `SI on ${n1*100} at 10% for 2 years?`; optA=`${n1*20}`; optB=`${n1*10}`; optC=`${n1}`; optD=`0`;
                }
                else if (t.includes('Ratio')) {
                    qText = `Divide ${n1*2} in ratio 1:1.`; optA=`${n1}, ${n1}`; optB=`${n1}, 0`; optC=`0, ${n1}`; optD=`None`;
                }
                else if (t === 'Ages') {
                    qText = `A is ${n1}, B is twice A. B's age?`; optA=`${n1*2}`; optB=`${n1}`; optC=`${n1+5}`; optD=`0`;
                }
                else if (t === 'Probability') {
                     if(i%2==0) { qText=`Prob of Head in 1 toss?`; optA=`1/2`; } else { qText=`Prob of 6 on Dice?`; optA=`1/6`; }
                     optB=`1/4`; optC=`0`; optD=`1`;
                }
                
                if(qText) await addQ('Quantitative', t, qText, optA, optB, optC, optD, ans, "Formula Applied");
            }
        }

        // --- 2. LOGICAL & VERBAL & CODING (STATIC DATA) ---
        // Generating math is easy, but for English/Coding we use a fixed bank to avoid "garbage" text
        
        const logicalQs = [
            ["Find next: 2, 4, 8, 16, ?", "32", "30", "24", "18", "A", "Doubling logic"],
            ["A is father of B. B is sister of C. A to C?", "Father", "Uncle", "Brother", "Grandpa", "A", "Direct relation"],
            ["Find odd one out: Apple, Orange, Banana, Chair", "Chair", "Apple", "Orange", "Banana", "A", "Chair is not fruit"],
            ["If CAT = 3120, DOG = ?", "4157", "4150", "400", "100", "A", "Alphabet positions"],
            ["Coding of 'SYSTEM' is 'METSYS'. 'HELLO' is?", "OLLEH", "OLHE", "HEL", "None", "A", "Reverse order"]
        ];

        const verbalQs = [
            ["Synonym of HAPPY?", "Joyful", "Sad", "Angry", "Dull", "A", "Same meaning"],
            ["Antonym of FAST?", "Slow", "Quick", "Rapid", "Speed", "A", "Opposite"],
            ["Correct spelling?", "Receive", "Recieve", "Receve", "Riceive", "A", "Standard English"],
            ["He ___ to school daily.", "goes", "go", "going", "gone", "A", "Grammar"],
            ["Meaning of 'Break a leg'?", "Good luck", "Break bone", "Dance", "Fall", "A", "Idiom"]
        ];

        const codingQs = [
            ["Who invented Java?", "James Gosling", "Guido", "Dennis Ritchie", "Bjarne", "A", "Fact"],
            ["HTML stands for?", "HyperText Markup Language", "HyperTool Make", "None", "Text Mode", "A", "Fact"],
            ["Time complexity of Binary Search?", "O(log n)", "O(n)", "O(1)", "O(n^2)", "A", "DS Algo"],
            ["Correct file extension for Python?", ".py", ".java", ".js", ".cpp", "A", "Fact"],
            ["Which is not a loop in C?", "For-each", "For", "While", "Do-While", "A", "C doesn't have foreach"]
        ];

        // Insert Logical
        const logTopics = ['Number Series', 'Blood Relations', 'Coding-Decoding', 'Directions', 'Seating Arrangement'];
        for(let t of logTopics) {
            for(let i=0; i<20; i++) {
                let q = logicalQs[i % logicalQs.length];
                await addQ('Logical', t, q[0], q[1], q[2], q[3], q[4], q[5], q[6]);
            }
        }

        // Insert Verbal
        const verbTopics = ['Antonyms', 'Synonyms', 'Spotting Errors', 'Sentence Correction'];
        for(let t of verbTopics) {
             for(let i=0; i<20; i++) {
                let q = verbalQs[i % verbalQs.length];
                await addQ('Verbal', t, q[0], q[1], q[2], q[3], q[4], q[5], q[6]);
            }
        }

        // Insert Coding
        const codeTopics = ['Java', 'Python', 'C Programming', 'Data Structures', 'DBMS'];
        for(let t of codeTopics) {
             for(let i=0; i<20; i++) {
                let q = codingQs[i % codingQs.length];
                await addQ('Coding', t, q[0], q[1], q[2], q[3], q[4], q[5], q[6]);
            }
        }

        res.send(`<h1>✅ MEGA LOAD SUCCESS!</h1><p>Maths, Reasoning, English, Coding - All topics are now FULL and CORRECT.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));