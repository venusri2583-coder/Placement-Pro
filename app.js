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

// =============================================================
// 🔥 REASONING LOADER (DOES NOT DELETE MATHS)
// =============================================================
app.get('/load-reasoning-data', async (req, res) => {
    try {
        // 1. DELETE ONLY OLD REASONING DATA (Safety for Maths)
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Logical'");

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // TOPICS FROM YOUR IMAGE
        const topics = [
            'Blood Relations', 'Number Series', 'Coding-Decoding', 'Syllogism', 
            'Seating Arrangement', 'Direction Sense', 'Clocks & Calendars', 
            'Analogy', 'Data Sufficiency', 'Logic Puzzles'
        ];

        for (let t of topics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";
                let n = i + 2; 

                // --- 1. NUMBER SERIES (Dynamic Logic) ---
                if (t === 'Number Series') {
                    if (i % 4 === 0) { // Arithmetic (+5)
                        qText = `Find next: ${n}, ${n+5}, ${n+10}, ${n+15}, ?`;
                        ansVal = `${n+20}`; w1=`${n+18}`; w2=`${n+25}`; w3=`${n+16}`;
                        explanation = `Series increases by +5.`;
                    } else if (i % 4 === 1) { // Squares
                        qText = `Find next: 4, 9, 16, 25, ?`; // Simplified for example
                        ansVal = `36`; w1=`30`; w2=`49`; w3=`32`;
                        explanation = `Squares of natural numbers (2^2, 3^2...).`;
                    } else if (i % 4 === 2) { // Multiplication
                        qText = `Find next: 2, 6, 18, 54, ?`;
                        ansVal = `162`; w1=`100`; w2=`108`; w3=`150`;
                        explanation = `Multiply previous number by 3.`;
                    } else { // Mixed
                        qText = `Find next: ${i*10}, ${i*9}, ${i*8}, ?`;
                        ansVal = `${i*7}`; w1=`${i*6}`; w2=`${i*5}`; w3=`0`;
                        explanation = `Decreasing multiples.`;
                    }
                }

                // --- 2. CODING DECODING ---
                else if (t === 'Coding-Decoding') {
                    if (i % 2 === 0) {
                        qText = `If CAT = 3120, then DOG = ?`;
                        ansVal = `4157`; w1=`4150`; w2=`3157`; w3=`400`;
                        explanation = `A=1, B=2, C=3... D=4, O=15, G=7.`;
                    } else {
                        qText = `If APPLE is coded as BQQMF (+1 logic), GRAPE = ?`;
                        ansVal = `HSBQF`; w1=`GRAPE`; w2=`FSAPE`; w3=`HQBQF`;
                        explanation = `Shift every letter by +1.`;
                    }
                }

                // --- 3. BLOOD RELATIONS ---
                else if (t === 'Blood Relations') {
                    if (i % 3 === 0) {
                        qText = `A is the brother of B. B is the father of C. How is A related to C?`;
                        ansVal = `Uncle`; w1=`Father`; w2=`Grandfather`; w3=`Brother`;
                        explanation = `Father's brother is Uncle.`;
                    } else if (i % 3 === 1) {
                        qText = `Pointing to a photo, a man said "She is the daughter of my grandfather's only son".`;
                        ansVal = `Sister`; w1=`Wife`; w2=`Mother`; w3=`Aunt`;
                        explanation = `Grandfather's only son = Father. Father's daughter = Sister.`;
                    } else {
                        qText = `A is mother of B. C is son of B. Relation of A to C?`;
                        ansVal = `Grandmother`; w1=`Mother`; w2=`Aunt`; w3=`Sister`;
                        explanation = `Father/Mother's mother is Grandmother.`;
                    }
                }

                // --- 4. CLOCKS & CALENDARS ---
                else if (t.includes('Clocks')) {
                    if (i % 2 === 0) { // Angle Formula
                        let h = 3, m = 30; // 3:30
                        qText = `Angle between hands at 3:30?`;
                        ansVal = `75 degrees`; w1=`90 degrees`; w2=`60 degrees`; w3=`0 degrees`;
                        explanation = `Formula: |30H - 5.5M| = |90 - 165| = 75.`;
                    } else { // Calendar
                        qText = `If today is Monday, what day will it be after 7 days?`;
                        ansVal = `Monday`; w1=`Tuesday`; w2=`Sunday`; w3=`Friday`;
                        explanation = `Days repeat every 7 days.`;
                    }
                }

                // --- 5. DIRECTION SENSE ---
                else if (t === 'Direction Sense') {
                    qText = `A man walks 3km North, then 4km East. How far from start?`;
                    ansVal = `5 km`; w1=`7 km`; w2=`3 km`; w3=`4 km`;
                    explanation = `Pythagoras Theorem: sqrt(3^2 + 4^2) = 5.`;
                }

                // --- 6. SYLLOGISM (Static Logic) ---
                else if (t === 'Syllogism') {
                    qText = `Statements: All A are B. All B are C. Conclusion: All A are C?`;
                    ansVal = `True`; w1=`False`; w2=`Maybe`; w3=`None`;
                    explanation = `If A is inside B, and B is inside C, then A is inside C.`;
                }

                // --- 7. ANALOGY ---
                else if (t === 'Analogy') {
                    if(i%2==0) { qText = `Doctor : Hospital :: Teacher : ?`; ansVal=`School`; w1=`Court`; w2=`Field`; w3=`Lab`; explanation=`Workplace relationship.`; }
                    else { qText = `Virus : Disease :: Exercise : ?`; ansVal=`Health`; w1=`Weakness`; w2=`Hospital`; w3=`Water`; explanation=`Cause and Effect.`; }
                }

                // --- 8. SEATING ARRANGEMENT ---
                else if (t === 'Seating Arrangement') {
                    qText = `5 friends (A,B,C,D,E) sit in a row. A is left of B. C is right of B. Who is middle? (Logic ${i})`;
                    ansVal = `B`; w1=`A`; w2=`C`; w3=`D`; explanation=`Arrangement logic based on left/right.`;
                }
                
                // --- DEFAULT FILLER ---
                else {
                    qText = `Logical Reasoning Question ${i} on ${t}`;
                    ansVal = `Correct Logic`; w1=`Wrong 1`; w2=`Wrong 2`; w3=`Wrong 3`;
                    explanation = `General logic applied.`;
                }

                // SHUFFLE & INSERT
                if(qText) {
                    let opts = shuffle([
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ]);

                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Logical', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }

        res.send(`<h1>✅ REASONING LOADED!</h1><p>Added Blood Relations, Series, Coding etc. <br> <b>Maths questions are SAFE and untouched.</b></p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
// =============================================================
// 🔥 FIX MISSING REASONING TOPICS (Clocks, Analogy, DS, Puzzles)
// =============================================================
app.get('/fix-missing-reasoning', async (req, res) => {
    try {
        // 1. Delete ONLY these 4 specific topics to avoid duplicates
        const missingTopics = [
            'Clocks & Calendars', 
            'Analogy', 
            'Data Sufficiency', 
            'Logic Puzzles'
        ];

        for (let t of missingTopics) {
            await db.execute("DELETE FROM aptitude_questions WHERE topic = ?", [t]);
        }

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        for (let t of missingTopics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";
                let n = i + 2;

                // --- 1. CLOCKS & CALENDARS ---
                if (t === 'Clocks & Calendars') {
                    if (i % 2 === 0) { // Angle
                        let h = 3, m = 30 + i; 
                        qText = `Find angle between hands at ${h}:${m}?`;
                        let angle = Math.abs(30*h - 5.5*m);
                        ansVal = `${angle}°`; w1=`${angle+10}°`; w2=`${angle-5}°`; w3=`0°`;
                        explanation = `Formula: |30H - 11/2M|.`;
                    } else { // Calendar
                        qText = `If 1st Jan 200${i} is Monday, what is 1st Jan 200${i+1}?`;
                        ansVal = `Tuesday`; w1=`Wednesday`; w2=`Sunday`; w3=`Friday`;
                        explanation = `Normal year +1 day, Leap year +2 days.`;
                    }
                }

                // --- 2. ANALOGY ---
                else if (t === 'Analogy') {
                    if(i % 3 === 0) {
                        qText = `Pen : Write :: Knife : ?`; ansVal=`Cut`; w1=`Vegetable`; w2=`Sharp`; w3=`Steel`; explanation=`Function relationship.`;
                    } else if(i % 3 === 1) {
                        qText = `Virus : Disease :: Exercise : ?`; ansVal=`Health`; w1=`Gym`; w2=`Running`; w3=`Sweat`; explanation=`Cause and Effect.`;
                    } else {
                        qText = `Good : Bad :: Roof : ?`; ansVal=`Floor`; w1=`Wall`; w2=`Window`; w3=`Sky`; explanation=`Antonyms.`;
                    }
                }

                // --- 3. DATA SUFFICIENCY ---
                else if (t === 'Data Sufficiency') {
                    qText = `Q: What is value of X? \n I. X + Y = 10 \n II. X - Y = 4`;
                    ansVal = `Both I and II required`; 
                    w1=`Only I is sufficient`; 
                    w2=`Only II is sufficient`; 
                    w3=`Neither is sufficient`;
                    explanation = `Solving two linear equations requires both statements.`;
                }

                // --- 4. LOGIC PUZZLES ---
                else if (t === 'Logic Puzzles') {
                    qText = `Logic Puzzle ${i}: Identify the odd behavior or pattern.`;
                    ansVal = `Correct Logic`; w1=`Wrong Logic`; w2=`Illogical`; w3=`None`;
                    explanation = `Requires critical thinking.`;
                }

                // SHUFFLE & INSERT
                if(qText) {
                    let opts = shuffle([
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ]);

                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Logical', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }

        res.send(`<h1>✅ MISSING TOPICS FIXED!</h1><p>Clocks, Analogy, DS, and Puzzles are now filled.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});

// =============================================================
// 🔥 FIX CORE REASONING (Series, Blood Relations, Coding, etc.)
// =============================================================
app.get('/fix-core-reasoning', async (req, res) => {
    try {
        // 1. Target ONLY the empty topics
        const coreTopics = [
            'Blood Relations', 
            'Number Series', 
            'Coding-Decoding', 
            'Syllogism', 
            'Seating Arrangement', 
            'Direction Sense'
        ];

        // 2. Clear ONLY these specific topics
        for (let t of coreTopics) {
            await db.execute("DELETE FROM aptitude_questions WHERE topic = ?", [t]);
        }

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        // Helper to shuffle options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        for (let t of coreTopics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", explanation="";
                let n = i + 5;

                // --- 1. NUMBER SERIES ---
                if (t === 'Number Series') {
                    if (i % 3 === 0) { // Arithmetic
                        qText = `Find next: ${n}, ${n+5}, ${n+10}, ${n+15}, ?`;
                        ansVal = `${n+20}`; w1=`${n+18}`; w2=`${n+25}`; w3=`${n+10}`;
                        explanation = `Add 5 to previous number.`;
                    } else if (i % 3 === 1) { // Geometric
                        qText = `Find next: 2, 6, 18, 54, ?`;
                        ansVal = `162`; w1=`100`; w2=`120`; w3=`200`;
                        explanation = `Multiply by 3.`;
                    } else { // Squares
                        qText = `Find next: 4, 9, 16, 25, ?`;
                        ansVal = `36`; w1=`49`; w2=`30`; w3=`32`;
                        explanation = `Squares of natural numbers.`;
                    }
                }

                // --- 2. CODING DECODING ---
                else if (t === 'Coding-Decoding') {
                    qText = `If A=1, B=2, what is BAD?`;
                    ansVal = `214`; w1=`123`; w2=`224`; w3=`114`;
                    explanation = `Direct letter numbering.`;
                }

                // --- 3. BLOOD RELATIONS ---
                else if (t === 'Blood Relations') {
                    qText = `A is brother of B. B is father of C. How is A related to C?`;
                    ansVal = `Uncle`; w1=`Father`; w2=`Grandfather`; w3=`Brother`;
                    explanation = `Father's brother is Uncle.`;
                }

                // --- 4. SYLLOGISM ---
                else if (t === 'Syllogism') {
                    qText = `Statement: All Cats are Dogs. Some Dogs are Birds. Conclusion: Some Cats are Birds?`;
                    ansVal = `False / Cannot be determined`; w1=`True`; w2=`Maybe`; w3=`None`;
                    explanation = `No direct relation given between Cats and Birds.`;
                }

                // --- 5. SEATING ARRANGEMENT ---
                else if (t === 'Seating Arrangement') {
                    qText = `5 people A,B,C,D,E sit in a row. C is in middle. A is left of C. B is right of C. Who is at immediate right of C?`;
                    ansVal = `B`; w1=`A`; w2=`D`; w3=`E`;
                    explanation = `Directly given in statement.`;
                }

                // --- 6. DIRECTION SENSE ---
                else if (t === 'Direction Sense') {
                    qText = `Person walks 3km North, then turns Right and walks 4km. Distance from start?`;
                    ansVal = `5km`; w1=`7km`; w2=`3km`; w3=`4km`;
                    explanation = `Pythagoras theorem: sqrt(3^2 + 4^2) = 5.`;
                }

                // SHUFFLE & INSERT
                if(qText) {
                    let opts = shuffle([
                        { val: ansVal, isCorrect: true },
                        { val: w1, isCorrect: false },
                        { val: w2, isCorrect: false },
                        { val: w3, isCorrect: false }
                    ]);

                    let finalAns = 'A';
                    if(opts[1].isCorrect) finalAns = 'B';
                    if(opts[2].isCorrect) finalAns = 'C';
                    if(opts[3].isCorrect) finalAns = 'D';

                    await addQ('Logical', t, qText, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, explanation);
                }
            }
        }

        res.send(`<h1>✅ CORE REASONING FIXED!</h1><p>Series, Coding, Blood Relations, Syllogism, Seating, Directions are now FILLED.</p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));