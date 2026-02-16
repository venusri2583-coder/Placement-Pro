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

app.post('/submit-quiz', requireLogin, async (req, res) => {
    const userAnswers = req.body;
    const topicName = req.body.topic_name;
    let score = 0;
    let totalQuestions = 0;
    let reviewData = [];

    try {
        // Topic ni batti anni 15 questions ni malli database nundi testunnam review kosam
        const [allQuestions] = await db.execute('SELECT * FROM aptitude_questions WHERE topic = ?', [topicName]);
        totalQuestions = allQuestions.length > 15 ? 15 : allQuestions.length;

        for (let i = 0; i < totalQuestions; i++) {
            const dbQ = allQuestions[i];
            const qId = dbQ.id;
            const userVal = userAnswers[`q${qId}`] ? userAnswers[`q${qId}`].toString().trim() : "Not Attempted";
            
            const correctOpt = dbQ.correct_option.trim(); // E.g., 'A'
            const correctVal = dbQ[`option_${correctOpt.toLowerCase()}`].toString().trim(); // E.g., '10km'
            
            // Check if user's answer is correct
            let isCorrect = (userVal === correctOpt) || (userVal === correctVal);
            if (isCorrect) score++;

            reviewData.push({
                q: dbQ.question,
                userAns: userVal,
                correctAns: `${correctOpt}) ${correctVal}`,
                explanation: dbQ.explanation || "Logic: Standard reasoning method applied.",
                isCorrect: isCorrect
            });
        }

        // Result ni database lo store chestunnam
        await db.execute('INSERT INTO mock_results (user_id, score, total, topic) VALUES (?, ?, ?, ?)', 
            [req.session.user.id, score, totalQuestions, topicName]);

        res.render('result', { score, total: totalQuestions, reviewData, user: req.session.user });
    } catch (err) {
        console.error(err);
        res.redirect('/');
    }
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

// =============================================================
// 🔥 ONLY REASONING FIX (MATHS SAFE MODE)
// =============================================================
app.get('/fix-only-reasoning', async (req, res) => {
    try {
        // 1. DELETE ONLY LOGICAL CATEGORY (Maths is SAFE)
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Logical'");

        const addQ = async (cat, topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [cat, topic, q, a, b, c, d, corr, exp]);
        };

        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // ALL REASONING TOPICS
        const topics = [
            'Blood Relations', 'Number Series', 'Coding-Decoding', 'Syllogism', 
            'Seating Arrangement', 'Direction Sense', 'Clocks & Calendars', 
            'Analogy', 'Data Sufficiency', 'Logic Puzzles'
        ];

        for (let t of topics) {
            for (let i = 1; i <= 20; i++) {
                
                let qText="", ansVal="", w1="", w2="", w3="", exp="";
                let n = i + 5;

                // --- 1. NUMBER SERIES ---
                if (t === 'Number Series') {
                    if (i % 3 === 0) { 
                        qText=`Find next: ${n}, ${n+5}, ${n+10}, ?`; ansVal=`${n+15}`; w1=`${n+12}`; w2=`${n+20}`; w3=`0`; exp=`Add 5 logic`; 
                    } else if (i % 3 === 1) { 
                        qText=`Find next: 2, 6, 18, ?`; ansVal=`54`; w1=`36`; w2=`72`; w3=`100`; exp=`Multiply by 3`; 
                    } else { 
                        qText=`Find next: 10, 20, 40, ?`; ansVal=`80`; w1=`60`; w2=`100`; w3=`50`; exp=`Double the number`; 
                    }
                }
                // --- 2. CODING ---
                else if (t === 'Coding-Decoding') {
                    qText=`If A=1, B=2, CAT=?`; ansVal=`24`; w1=`20`; w2=`26`; w3=`15`; exp=`Sum of positions (3+1+20)`;
                }
                // --- 3. BLOOD RELATIONS ---
                else if (t === 'Blood Relations') {
                    qText=`A is father of B. B is sister of C. A to C?`; ansVal=`Father`; w1=`Uncle`; w2=`Brother`; w3=`Grandpa`; exp=`Direct relation`;
                }
                // --- 4. SYLLOGISM ---
                else if (t === 'Syllogism') {
                    qText=`Statement: All A are B. No B is C. Conclusion: No A is C?`; ansVal=`True`; w1=`False`; w2=`Maybe`; w3=`None`; exp=`A is inside B, B touches no C.`;
                }
                // --- 5. DIRECTIONS ---
                else if (t === 'Direction Sense') {
                    qText=`Walk 3km North, turn Right, walk 4km. Dist?`; ansVal=`5km`; w1=`7km`; w2=`3km`; w3=`4km`; exp=`Pythagoras theorem`;
                }
                // --- 6. SEATING ---
                else if (t === 'Seating Arrangement') {
                    qText=`A, B, C sit in row. A is left of B. C is right of B. Middle?`; ansVal=`B`; w1=`A`; w2=`C`; w3=`None`; exp=`Order: A - B - C`;
                }
                // --- 7. CLOCKS ---
                else if (t.includes('Clocks')) {
                    qText=`Angle at 3:00?`; ansVal=`90°`; w1=`180°`; w2=`60°`; w3=`0°`; exp=`3 gaps * 30 deg`;
                }
                // --- 8. ANALOGY ---
                else if (t === 'Analogy') {
                    qText=`Day : Night :: Up : ?`; ansVal=`Down`; w1=`Sky`; w2=`High`; w3=`Low`; exp=`Antonyms`;
                }
                // --- 9. DATA SUFFICIENCY ---
                else if (t === 'Data Sufficiency') {
                    qText=`Value of x? I. x+y=5 II. x-y=1`; ansVal=`Both required`; w1=`Only I`; w2=`Only II`; w3=`None`; exp=`Linear equations`;
                }
                // --- 10. PUZZLES ---
                else {
                    qText=`Logical Puzzle Q${i}`; ansVal=`Logic A`; w1=`Logic B`; w2=`Logic C`; w3=`Logic D`; exp=`Reasoning check`;
                }

                // Shuffle Options
                let opts = shuffle([{v:ansVal,c:true}, {v:w1,c:false}, {v:w2,c:false}, {v:w3,c:false}]);
                let f='A'; if(opts[1].c)f='B'; if(opts[2].c)f='C'; if(opts[3].c)f='D';

                await addQ('Logical', t, qText, opts[0].v, opts[1].v, opts[2].v, opts[3].v, f, exp);
            }
        }

        res.send(`<h1>✅ REASONING FIXED!</h1><p>Blood Relations, Series, Coding... all filled. <br> <b>Maths (Aptitude) is 100% SAFE.</b></p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
// =============================================================
// 📘 ENGLISH ROUTE (Matching Your EJS Icons Logic)
// =============================================================
app.get('/english-topics', requireLogin, (req, res) => {
    // ఈ పేర్లు నీ EJS లోని if(tn.includes('...')) కండిషన్స్ కి కరెక్ట్ గా మ్యాచ్ అవుతాయి
    const englishTopics = [
        { topic: 'Parts of Speech' },             // Matches 'parts of speech' icon
        { topic: 'Tenses' },                      // Matches 'tenses' icon
        { topic: 'Active and Passive Voice' },    // Matches 'voice' icon
        { topic: 'Direct and Indirect Speech' },  // Matches 'speech' icon
        { topic: 'Subject-Verb Agreement' },      // Matches 'agreement' icon
        { topic: 'Spotting Errors' },             // Matches 'error' icon
        { topic: 'Synonyms and Antonyms' },       // Matches 'synonyms' icon
        { topic: 'Idioms and Phrases' },          // Matches 'idioms' icon
        { topic: 'One Word Substitution' },       // Matches 'substitution' icon
        { topic: 'Spelling Test' },               // Matches 'spelling' icon
        { topic: 'Fill in the Blanks' },          // Matches 'fill' icon
        { topic: 'Phrasal Verbs' },               // Matches 'phrasal' icon
        { topic: 'Reading Comprehension' },       // Matches 'comprehension' icon
        { topic: 'Cloze Test' },                  // Matches 'cloze' icon
        { topic: 'Sentence Rearrangement' }       // Matches 'rearrangement' icon
    ];

    res.render('english_topics', { 
        user: req.session.user, 
        topics: englishTopics 
    });
});
// =============================================================
// 🔥 ENGLISH ULTIMATE FIX (ALL 15 TOPICS - NO REPETITION)
// =============================================================
app.get('/fix-english-ultimate', async (req, res) => {
    try {
        // 1. SAFE DELETE: Only remove English (Verbal) questions
        await db.execute("DELETE FROM aptitude_questions WHERE category = 'Verbal'");

        const addQ = async (topic, q, a, b, c, d, corr, exp) => {
            await db.execute(`INSERT INTO aptitude_questions 
            (category, topic, question, option_a, option_b, option_c, option_d, correct_option, explanation) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['Verbal', topic, q, a, b, c, d, corr, exp]);
        };

        // Helper function for shuffling options
        function shuffle(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array;
        }

        // --- MASTER DATA BANK: 15 UNIQUE QUESTIONS PER TOPIC ---
        const questionBank = {
            'Parts of Speech': [
                {q:'Identify NOUN: "Honesty is the best policy."', a:'Honesty', w1:'Best', w2:'Is', w3:'The', exp:'Abstract noun.'},
                {q:'Identify VERB: "They played cricket."', a:'Played', w1:'They', w2:'Cricket', w3:'None', exp:'Action word.'},
                {q:'Identify ADJECTIVE: "She is a smart girl."', a:'Smart', w1:'Girl', w2:'She', w3:'Is', exp:'Describes the noun girl.'},
                {q:'Identify ADVERB: "He runs quickly."', a:'Quickly', w1:'Runs', w2:'He', w3:'None', exp:'Describes how he runs.'},
                {q:'Identify PRONOUN: "He is my brother."', a:'He', w1:'Brother', w2:'My', w3:'Is', exp:'Replaces the name.'},
                {q:'Identify PREPOSITION: "The book is on the table."', a:'On', w1:'Table', w2:'Book', w3:'Is', exp:'Shows position.'},
                {q:'Identify CONJUNCTION: "Ram and Shyam."', a:'And', w1:'Ram', w2:'Shyam', w3:'None', exp:'Joining word.'},
                {q:'Identify INTERJECTION: "Wow! Nice car."', a:'Wow', w1:'Nice', w2:'Car', w3:'None', exp:'Expresses emotion.'},
                {q:'Identify NOUN: "Gold is expensive."', a:'Gold', w1:'Expensive', w2:'Is', w3:'None', exp:'Material noun.'},
                {q:'Identify VERB: "I am writing."', a:'Writing', w1:'I', w2:'Am', w3:'None', exp:'Action in progress.'},
                {q:'Identify ADJECTIVE: "Red flower."', a:'Red', w1:'Flower', w2:'None', w3:'A', exp:'Describes color.'},
                {q:'Identify ADVERB: "Speak softly."', a:'Softly', w1:'Speak', w2:'None', w3:'A', exp:'Manner of speaking.'},
                {q:'Identify PREPOSITION: "Go to school."', a:'To', w1:'Go', w2:'School', w3:'None', exp:'Direction.'},
                {q:'Identify PRONOUN: "It is raining."', a:'It', w1:'Raining', w2:'Is', w3:'None', exp:'Impersonal pronoun.'},
                {q:'Identify CONJUNCTION: "Work hard or fail."', a:'Or', w1:'Work', w2:'Fail', w3:'Hard', exp:'Shows choice.'}
            ],
            'Tenses': [
                {q:'Simple Present: Sun ___ in the east.', a:'rises', w1:'rose', w2:'rising', w3:'rise', exp:'Universal truth.'},
                {q:'Present Continuous: Look! He ___ .', a:'is coming', w1:'comes', w2:'came', w3:'come', exp:'Happening now.'},
                {q:'Present Perfect: I ___ my work.', a:'have finished', w1:'has finished', w2:'finished', w3:'finish', exp:'Just completed action.'},
                {q:'Simple Past: She ___ yesterday.', a:'came', w1:'come', w2:'coming', w3:'comes', exp:'Past action.'},
                {q:'Past Continuous: I ___ when he called.', a:'was sleeping', w1:'slept', w2:'sleep', w3:'sleeping', exp:'Action in progress in past.'},
                {q:'Simple Future: I ___ go tomorrow.', a:'will', w1:'did', w2:'had', w3:'have', exp:'Future indicator.'},
                {q:'Past Perfect: The train ___ left.', a:'had', w1:'has', w2:'have', w3:'was', exp:'Completed before past time.'},
                {q:'He usually ___ tea.', a:'drinks', w1:'drink', w2:'drinking', w3:'drank', exp:'Habit.'},
                {q:'I ___ for you since morning.', a:'have been waiting', w1:'am waiting', w2:'wait', w3:'waited', exp:'Pres. Perf. Cont.'},
                {q:'If I worked hard, I ___ pass.', a:'would', w1:'will', w2:'shall', w3:'can', exp:'Conditional type 2.'},
                {q:'By next year, I ___ graduated.', a:'will have', w1:'will be', w2:'have', w3:'had', exp:'Future Perfect.'},
                {q:'Water ___ at 100 degrees.', a:'boils', w1:'boil', w2:'boiled', w3:'boiling', exp:'Scientific fact.'},
                {q:'She ___ not know me.', a:'does', w1:'do', w2:'is', w3:'has', exp:'Negative simple present.'},
                {q:'Did you ___ him?', a:'see', w1:'saw', w2:'seen', w3:'seeing', exp:'Did takes V1.'},
                {q:'I ___ writing a letter now.', a:'am', w1:'was', w2:'were', w3:'be', exp:'Present continuous.'}
            ],
            'Active and Passive Voice': [
                {q:'"I play cricket."', a:'Cricket is played by me.', w1:'Cricket was played.', w2:'Cricket played.', w3:'None', exp:'Simple present passive.'},
                {q:'"She sang a song."', a:'A song was sung by her.', w1:'A song is sung.', w2:'A song sung.', w3:'None', exp:'Simple past passive.'},
                {q:'"Open the box."', a:'Let the box be opened.', w1:'Box opened.', w2:'Open box.', w3:'None', exp:'Imperative.'},
                {q:'"Who did this?"', a:'By whom was this done?', w1:'Who done this?', w2:'By who done?', w3:'None', exp:'Interrogative.'},
                {q:'"I am eating a mango."', a:'A mango is being eaten by me.', w1:'A mango was eaten.', w2:'A mango eaten.', w3:'None', exp:'Present continuous.'},
                {q:'"He has done it."', a:'It has been done by him.', w1:'It was done.', w2:'It is done.', w3:'None', exp:'Present perfect.'},
                {q:'"They will help us."', a:'We shall be helped by them.', w1:'We will helped.', w2:'We are helped.', w3:'None', exp:'Simple future.'},
                {q:'"Respect elders."', a:'Elders should be respected.', w1:'Respect the elders.', w2:'Elders respected.', w3:'None', exp:'Suggestion.'},
                {q:'"I know him."', a:'He is known to me.', w1:'He is known by me.', w2:'He was known.', w3:'None', exp:'Know takes "to".'},
                {q:'"Someone stole my watch."', a:'My watch was stolen.', w1:'My watch is stolen.', w2:'Watch stolen.', w3:'None', exp:'Agent unknown.'},
                {q:'"She was writing a letter."', a:'A letter was being written by her.', w1:'A letter is written.', w2:'Letter written.', w3:'None', exp:'Past continuous.'},
                {q:'"Did he buy a car?"', a:'Was a car bought by him?', w1:'Is a car bought?', w2:'Did a car bought?', w3:'None', exp:'Past interrogative.'},
                {q:'"Please help me."', a:'You are requested to help me.', w1:'Help me please.', w2:'I am helped.', w3:'None', exp:'Request.'},
                {q:'"We expect good news."', a:'Good news is expected.', w1:'Good news was expected.', w2:'News expected.', w3:'None', exp:'Simple present.'},
                {q:'"He teaches us English."', a:'We are taught English by him.', w1:'English taught us.', w2:'We taught English.', w3:'None', exp:'Double object.'}
            ],
            'Direct and Indirect Speech': [
                {q:'He said, "I am busy."', a:'He said that he was busy.', w1:'He said he is busy.', w2:'He says he was busy.', w3:'None', exp:'Present -> Past.'},
                {q:'She said, "I cooked rice."', a:'She said that she had cooked rice.', w1:'She said she cooked rice.', w2:'She says she cooked.', w3:'None', exp:'Past -> Past Perfect.'},
                {q:'Ram said, "I will go."', a:'Ram said that he would go.', w1:'Ram said he will go.', w2:'Ram said he goes.', w3:'None', exp:'Will -> Would.'},
                {q:'He said to me, "Are you ill?"', a:'He asked me if I was ill.', w1:'He asked if I am ill.', w2:'He said if I was ill.', w3:'None', exp:'Question uses if/whether.'},
                {q:'Teacher said, "Sun rises in East."', a:'Teacher said that Sun rises in East.', w1:'Teacher said Sun rose.', w2:'Teacher asked if Sun rose.', w3:'None', exp:'Universal truth no change.'},
                {q:'He said, "Please help me."', a:'He requested me to help him.', w1:'He said to help.', w2:'He ordered to help.', w3:'None', exp:'Imperative request.'},
                {q:'She said, "Alas! I am ruined."', a:'She exclaimed with sorrow that she was ruined.', w1:'She said alas she ruined.', w2:'She cried she is ruined.', w3:'None', exp:'Exclamatory.'},
                {q:'He said, "Where do you live?"', a:'He asked me where I lived.', w1:'He asked where do I live.', w2:'He said where I lived.', w3:'None', exp:'Wh-question.'},
                {q:'Ravi said, "I have passed."', a:'Ravi said that he had passed.', w1:'Ravi said he has passed.', w2:'Ravi said he passed.', w3:'None', exp:'Present Perfect -> Past Perfect.'},
                {q:'He says, "I am fine."', a:'He says that he is fine.', w1:'He says he was fine.', w2:'He said he is fine.', w3:'None', exp:'Reporting verb present -> No tense change.'},
                {q:'She said, "I can swim."', a:'She said that she could swim.', w1:'She said she can swim.', w2:'She said she swims.', w3:'None', exp:'Can -> Could.'},
                {q:'He said, "Let us play."', a:'He proposed that they should play.', w1:'He said let us play.', w2:'He asked to play.', w3:'None', exp:'Suggestion.'},
                {q:'Father said, "Don\'t go out."', a:'Father forbade me to go out.', w1:'Father said not go.', w2:'Father asked don\'t go.', w3:'None', exp:'Negative command.'},
                {q:'He said, "I saw him yesterday."', a:'He said he had seen him the previous day.', w1:'He said he saw him yesterday.', w2:'He said he see him.', w3:'None', exp:'Yesterday -> Previous day.'},
                {q:'"What a beautiful sight!" said he.', a:'He exclaimed that it was a very beautiful sight.', w1:'He said it is beautiful.', w2:'He asked what beautiful.', w3:'None', exp:'Exclamatory sentence.'}
            ],
            'Subject-Verb Agreement': [
                {q:'Bread and butter ___ my favorite.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Single idea.'},
                {q:'One of the boys ___ missing.', a:'is', w1:'are', w2:'were', w3:'have', exp:'One takes singular.'},
                {q:'The police ___ coming.', a:'are', w1:'is', w2:'was', w3:'has', exp:'Police is plural.'},
                {q:'Mathematics ___ hard.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Subject name is singular.'},
                {q:'Neither he nor I ___ going.', a:'am', w1:'is', w2:'are', w3:'were', exp:'Agree with nearest subject (I).'},
                {q:'Each of the girls ___ a pen.', a:'has', w1:'have', w2:'are', w3:'were', exp:'Each takes singular.'},
                {q:'Time and tide ___ for none.', a:'wait', w1:'waits', w2:'waiting', w3:'weighted', exp:'Plural subjects.'},
                {q:'Fifty kilometers ___ a long way.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Distance as a unit is singular.'},
                {q:'The jury ___ divided.', a:'were', w1:'is', w2:'was', w3:'has', exp:'Divided opinion takes plural.'},
                {q:'Gold and Silver ___ precious.', a:'are', w1:'is', w2:'was', w3:'has', exp:'Two nouns joined by and.'},
                {q:'Every man and woman ___ happy.', a:'was', w1:'were', w2:'are', w3:'have', exp:'Every takes singular.'},
                {q:'The quality of mangoes ___ good.', a:'was', w1:'were', w2:'are', w3:'have', exp:'Subject is Quality (singular).'},
                {q:'Slow and steady ___ the race.', a:'wins', w1:'win', w2:'winning', w3:'won', exp:'Single idea.'},
                {q:'Many a man ___ done this.', a:'has', w1:'have', w2:'are', w3:'were', exp:'Many a takes singular.'},
                {q:'Physics ___ my subject.', a:'is', w1:'are', w2:'were', w3:'have', exp:'Subject name.'}
            ],
            'Spotting Errors': [
                {q:'Error: "One of the boy is here."', a:'boy', w1:'One', w2:'is', w3:'here', exp:'Should be "boys".'},
                {q:'Error: "He don\'t know."', a:'don\'t', w1:'He', w2:'know', w3:'None', exp:'Should be "doesn\'t".'},
                {q:'Error: "I prefer coffee than tea."', a:'than', w1:'prefer', w2:'coffee', w3:'tea', exp:'Prefer takes "to".'},
                {q:'Error: "She go to school."', a:'go', w1:'She', w2:'to', w3:'school', exp:'Should be "goes".'},
                {q:'Error: "Return back home."', a:'back', w1:'Return', w2:'home', w3:'None', exp:'Return implies back. Remove back.'},
                {q:'Error: "He is my cousin brother."', a:'brother', w1:'He', w2:'is', w3:'cousin', exp:'Cousin implies brother/sister.'},
                {q:'Error: "My hairs are black."', a:'hairs', w1:'My', w2:'are', w3:'black', exp:'Hair is uncountable.'},
                {q:'Error: "The sceneries are good."', a:'sceneries', w1:'The', w2:'are', w3:'good', exp:'Scenery has no plural.'},
                {q:'Error: "He discussed about it."', a:'about', w1:'He', w2:'discussed', w3:'it', exp:'Discuss takes direct object.'},
                {q:'Error: "Please reply back."', a:'back', w1:'Please', w2:'reply', w3:'None', exp:'Reply implies back.'},
                {q:'Error: "He is senior than me."', a:'than', w1:'He', w2:'senior', w3:'me', exp:'Senior takes "to".'},
                {q:'Error: "I have many works."', a:'works', w1:'have', w2:'many', w3:'I', exp:'Work is uncountable.'},
                {q:'Error: "Unless you do not work."', a:'do not', w1:'Unless', w2:'work', w3:'you', exp:'Unless is negative.'},
                {q:'Error: "The cattles are grazing."', a:'cattles', w1:'The', w2:'are', w3:'grazing', exp:'Cattle is already plural.'},
                {q:'Error: "Did he went?"', a:'went', w1:'Did', w2:'he', w3:'None', exp:'Did takes V1 (go).'}
            ],
            'Synonyms and Antonyms': [
                {q:'Synonym: ABANDON', a:'Forsake', w1:'Keep', w2:'Join', w3:'Love', exp:'To leave.'},
                {q:'Synonym: BRIEF', a:'Short', w1:'Long', w2:'Large', w3:'Deep', exp:'Concise.'},
                {q:'Synonym: CEASE', a:'Stop', w1:'Start', w2:'Begin', w3:'Go', exp:'End.'},
                {q:'Synonym: DEFER', a:'Postpone', w1:'Hasten', w2:'Speed', w3:'Do', exp:'Delay.'},
                {q:'Synonym: EAGER', a:'Keen', w1:'Bored', w2:'Dull', w3:'Slow', exp:'Excited.'},
                {q:'Synonym: FATAL', a:'Deadly', w1:'Safe', w2:'Good', w3:'Life', exp:'Causing death.'},
                {q:'Synonym: GIGANTIC', a:'Huge', w1:'Tiny', w2:'Small', w3:'Little', exp:'Very big.'},
                {q:'Synonym: HUMBLE', a:'Modest', w1:'Proud', w2:'Rude', w3:'Loud', exp:'Not proud.'},
                {q:'Antonym: ANCIENT', a:'Modern', w1:'Old', w2:'Past', w3:'Aged', exp:'New.'},
                {q:'Antonym: BOLD', a:'Timid', w1:'Brave', w2:'Strong', w3:'Hard', exp:'Fearful.'},
                {q:'Antonym: CREATE', a:'Destroy', w1:'Make', w2:'Build', w3:'Form', exp:'Ruin.'},
                {q:'Antonym: DEEP', a:'Shallow', w1:'Low', w2:'Bottom', w3:'Down', exp:'Not deep.'},
                {q:'Antonym: EXPAND', a:'Contract', w1:'Grow', w2:'Big', w3:'Wide', exp:'Shrink.'},
                {q:'Antonym: FREEDOM', a:'Slavery', w1:'Liberty', w2:'Free', w3:'Open', exp:'Bondage.'},
                {q:'Antonym: GUILTY', a:'Innocent', w1:'Bad', w2:'Wrong', w3:'Sinful', exp:'Not guilty.'}
            ],
            'Idioms and Phrases': [
                {q:'"Apple of one\'s eye"', a:'Very dear', w1:'Fruit', w2:'Blind', w3:'Enemy', exp:'Favorite person.'},
                {q:'"Bed of roses"', a:'Comfortable life', w1:'Garden', w2:'Thorns', w3:'Flowers', exp:'Easy situation.'},
                {q:'"Black sheep"', a:'Unworthy person', w1:'Animal', w2:'Dark', w3:'Wool', exp:'Disgrace to family.'},
                {q:'"Break the ice"', a:'Start conversation', w1:'Break ice', w2:'Cold', w3:'Hit', exp:'Ease tension.'},
                {q:'"Crocodile tears"', a:'False sorrow', w1:'Real sad', w2:'Animal', w3:'Crying', exp:'Pretended grief.'},
                {q:'"Once in a blue moon"', a:'Rarely', w1:'Always', w2:'Often', w3:'Night', exp:'Very infrequent.'},
                {q:'"Piece of cake"', a:'Very easy', w1:'Tasty', w2:'Food', w3:'Hard', exp:'Simple task.'},
                {q:'"Rain cats and dogs"', a:'Rain heavily', w1:'Animals', w2:'Fight', w3:'Pet', exp:'Heavy rain.'},
                {q:'"White elephant"', a:'Costly but useless', w1:'Animal', w2:'Big', w3:'Rare', exp:'Burden.'},
                {q:'"A bone of contention"', a:'Cause of quarrel', w1:'Food', w2:'Dog', w3:'Bone', exp:'Dispute source.'},
                {q:'"By hook or by crook"', a:'By any means', w1:'Fishing', w2:'Walking', w3:'Stick', exp:'Any method.'},
                {q:'"Cock and bull story"', a:'False story', w1:'Animals', w2:'Farm', w3:'True', exp:'Lie.'},
                {q:'"Fair weather friend"', a:'Friend in good times', w1:'Best friend', w2:'Enemy', w3:'Weather', exp:'Unreliable friend.'},
                {q:'"Lion\'s share"', a:'Major part', w1:'Animal', w2:'King', w3:'Small', exp:'Biggest portion.'},
                {q:'"Turn a deaf ear"', a:'Ignore', w1:'Listen', w2:'Ear', w3:'Hear', exp:'Refuse to listen.'}
            ],
            'One Word Substitution': [
                {q:'Life history written by self', a:'Autobiography', w1:'Biography', w2:'History', w3:'Novel', exp:'Auto = self.'},
                {q:'Life history written by other', a:'Biography', w1:'Autobiography', w2:'Story', w3:'Tale', exp:'Bio = life.'},
                {q:'Government by the people', a:'Democracy', w1:'Autocracy', w2:'Monarchy', w3:'Rule', exp:'Demos = people.'},
                {q:'One who believes in God', a:'Theist', w1:'Atheist', w2:'Pagan', w3:'Saint', exp:'Theo = God.'},
                {q:'One who denies God', a:'Atheist', w1:'Theist', w2:'Monk', w3:'Holy', exp:'A = no.'},
                {q:'One who eats everything', a:'Omnivorous', w1:'Carnivorous', w2:'Herbivorous', w3:'Eater', exp:'Omni = all.'},
                {q:'One who eats flesh', a:'Carnivorous', w1:'Omnivorous', w2:'Vegan', w3:'Man', exp:'Carni = flesh.'},
                {q:'Place where birds are kept', a:'Aviary', w1:'Apiary', w2:'Zoo', w3:'Cage', exp:'Avis = bird.'},
                {q:'Place where bees are kept', a:'Apiary', w1:'Aviary', w2:'Hive', w3:'Farm', exp:'Apis = bee.'},
                {q:'A cure for all diseases', a:'Panacea', w1:'Medicine', w2:'Drug', w3:'Health', exp:'Universal cure.'},
                {q:'One who loves books', a:'Bibliophile', w1:'Reader', w2:'Writer', w3:'Book', exp:'Biblio = book.'},
                {q:'Sound that cannot be heard', a:'Inaudible', w1:'Audible', w2:'Loud', w3:'Silent', exp:'In = not.'},
                {q:'That which leads to death', a:'Fatal', w1:'Safe', w2:'Bad', w3:'Sick', exp:'Deadly.'},
                {q:'One who knows everything', a:'Omniscient', w1:'Wise', w2:'Smart', w3:'God', exp:'Sci = know.'},
                {q:'Murder of a king', a:'Regicide', w1:'Suicide', w2:'Homicide', w3:'Kill', exp:'Regis = king.'}
            ],
            'Spelling Test': [
                {q:'Choose correct spelling:', a:'Lieutenant', w1:'Leutenant', w2:'Lieutenent', w3:'Lutenant', exp:'L-i-e-u-t-e-n-a-n-t.'},
                {q:'Choose correct spelling:', a:'Vacuum', w1:'Vaccuum', w2:'Vacume', w3:'Vaccum', exp:'One c, two u.'},
                {q:'Choose correct spelling:', a:'Colonel', w1:'Colnel', w2:'Colonal', w3:'Kernal', exp:'Pronounced kernel.'},
                {q:'Choose correct spelling:', a:'Embarrass', w1:'Embarass', w2:'Embarras', w3:'Emberass', exp:'Double r, double s.'},
                {q:'Choose correct spelling:', a:'Accommodation', w1:'Accomodation', w2:'Acommodation', w3:'Acomodation', exp:'Double c, double m.'},
                {q:'Choose correct spelling:', a:'Separate', w1:'Seperate', w2:'Seperat', w3:'Seprate', exp:'S-e-p-a-r-a-t-e.'},
                {q:'Choose correct spelling:', a:'Queue', w1:'Que', w2:'Qeue', w3:'Quue', exp:'Q-u-e-u-e.'},
                {q:'Choose correct spelling:', a:'Bureaucracy', w1:'Burocracy', w2:'Bureacracy', w3:'Burocracy', exp:'Beau-crat.'},
                {q:'Choose correct spelling:', a:'Psychology', w1:'Sychology', w2:'Pyschology', w3:'Psycholgy', exp:'Silent P.'},
                {q:'Choose correct spelling:', a:'Restaurant', w1:'Restarant', w2:'Resturant', w3:'Restuarant', exp:'Rest-au-rant.'},
                {q:'Choose correct spelling:', a:'Maintenance', w1:'Maintainance', w2:'Maintanance', w3:'Maintenence', exp:'Main-ten-ance.'},
                {q:'Choose correct spelling:', a:'Grammar', w1:'Grammer', w2:'Gramar', w3:'Gramer', exp:'Ends in -ar.'},
                {q:'Choose correct spelling:', a:'Receive', w1:'Recieve', w2:'Riceive', w3:'Receve', exp:'E before I.'},
                {q:'Choose correct spelling:', a:'Necessary', w1:'Neccessary', w2:'Necesary', w3:'Necessery', exp:'One c, two s.'},
                {q:'Choose correct spelling:', a:'Occasion', w1:'Occassion', w2:'Ocasion', w3:'Occation', exp:'Two c, one s.'}
            ],
            'Fill in the Blanks': [
                {q:'He is addicted ___ smoking.', a:'to', w1:'of', w2:'with', w3:'in', exp:'Addicted to.'},
                {q:'She is afraid ___ dogs.', a:'of', w1:'from', w2:'with', w3:'by', exp:'Afraid of.'},
                {q:'He died ___ cancer.', a:'of', w1:'from', w2:'by', w3:'with', exp:'Died of disease.'},
                {q:'I prefer tea ___ coffee.', a:'to', w1:'than', w2:'over', w3:'from', exp:'Prefer to.'},
                {q:'He is good ___ English.', a:'at', w1:'in', w2:'on', w3:'with', exp:'Good at a subject.'},
                {q:'Listen ___ me.', a:'to', w1:'at', w2:'on', w3:'with', exp:'Listen to.'},
                {q:'Look ___ the blackboard.', a:'at', w1:'on', w2:'in', w3:'to', exp:'Look at.'},
                {q:'The cat jumped ___ the table.', a:'upon', w1:'on', w2:'in', w3:'at', exp:'Motion upwards.'},
                {q:'Divide this ___ two parts.', a:'into', w1:'in', w2:'to', w3:'on', exp:'Change of state.'},
                {q:'He is married ___ her.', a:'to', w1:'with', w2:'by', w3:'for', exp:'Married to.'},
                {q:'Beware ___ dogs.', a:'of', w1:'from', w2:'to', w3:'with', exp:'Beware of.'},
                {q:'I agree ___ you.', a:'with', w1:'to', w2:'on', w3:'at', exp:'Agree with person.'},
                {q:'He deals ___ sugar.', a:'in', w1:'with', w2:'at', w3:'on', exp:'Trade in.'},
                {q:'The book is ___ the table.', a:'on', w1:'in', w2:'at', w3:'to', exp:'Surface.'},
                {q:'He came ___ bus.', a:'by', w1:'in', w2:'on', w3:'with', exp:'Travel by.'}
            ],
            'Phrasal Verbs': [
                {q:'"Give up"', a:'Stop trying', w1:'Give gift', w2:'Start', w3:'Win', exp:'Surrender.'},
                {q:'"Call off"', a:'Cancel', w1:'Call loud', w2:'Visit', w3:'Phone', exp:'End event.'},
                {q:'"Look after"', a:'Take care of', w1:'Look behind', w2:'See', w3:'Ignore', exp:'Care.'},
                {q:'"Run out of"', a:'Have none left', w1:'Run fast', w2:'Go out', w3:'Exit', exp:'Deplete.'},
                {q:'"Put off"', a:'Postpone', w1:'Wear', w2:'Switch off', w3:'Drop', exp:'Delay.'},
                {q:'"Break down"', a:'Stop working', w1:'Cry', w2:'Dance', w3:'Fall', exp:'Machine failure.'},
                {q:'"Carry on"', a:'Continue', w1:'Lift', w2:'Stop', w3:'Drop', exp:'Keep doing.'},
                {q:'"Get up"', a:'Rise', w1:'Sleep', w2:'Sit', w3:'Run', exp:'Wake up.'},
                {q:'"Look for"', a:'Search', w1:'See', w2:'Watch', w3:'Hide', exp:'Find.'},
                {q:'"Take off"', a:'Remove/Fly', w1:'Put on', w2:'Land', w3:'Run', exp:'Plane start.'},
                {q:'"Bring up"', a:'Raise', w1:'Vomit', w2:'Carry', w3:'Drop', exp:'Rear child.'},
                {q:'"Pass away"', a:'Die', w1:'Go past', w2:'Faint', w3:'Leave', exp:'Death euphemism.'},
                {q:'"Turn down"', a:'Reject', w1:'Rotate', w2:'Accept', w3:'Low', exp:'Refuse.'},
                {q:'"Set up"', a:'Establish', w1:'Sit', w2:'Fall', w3:'End', exp:'Start business.'},
                {q:'"Make up"', a:'Invent/Repair', w1:'Paint', w2:'Break', w3:'Cry', exp:'Reconcile/Create.'}
            ],
            'Reading Comprehension': [
                {q:'Passage: "Honesty pays." Idea?', a:'Be honest', w1:'Lie', w2:'Pay money', w3:'Rob', exp:'Moral.'},
                {q:'Passage: "Water is life." Idea?', a:'Conserve water', w1:'Waste it', w2:'Drink cola', w3:'Swim', exp:'Importance.'},
                {q:'Passage: "Time is money." Idea?', a:'Value time', w1:'Sell watches', w2:'Waste time', w3:'Sleep', exp:'Productivity.'},
                {q:'Passage: "Unity is strength." Idea?', a:'Stay together', w1:'Fight', w2:'Alone', w3:'Weak', exp:'Teamwork.'},
                {q:'Passage: "Health is wealth." Idea?', a:'Stay fit', w1:'Get rich', w2:'Eat junk', w3:'Sick', exp:'Wellbeing.'},
                {q:'Passage: "Knowledge is power." Idea?', a:'Learn more', w1:'Fight', w2:'Ignore', w3:'Sleep', exp:'Education.'},
                {q:'Passage: "Practice makes perfect." Idea?', a:'Work hard', w1:'Lazy', w2:'Quit', w3:'Luck', exp:'Effort.'},
                {q:'Passage: "Save trees." Idea?', a:'Protect nature', w1:'Cut them', w2:'Build', w3:'Burn', exp:'Environment.'},
                {q:'Passage: "Look before you leap." Idea?', a:'Think first', w1:'Jump', w2:'Run', w3:'Blind', exp:'Caution.'},
                {q:'Passage: "Slow and steady." Idea?', a:'Consistency', w1:'Speed', w2:'Rush', w3:'Stop', exp:'Patience.'},
                {q:'Passage: "All that glitters..." Idea?', a:'Looks deceive', w1:'Gold is good', w2:'Shine', w3:'Rich', exp:'Reality.'},
                {q:'Passage: "Prevention is better..." Idea?', a:'Avoid issues', w1:'Cure', w2:'Sick', w3:'Wait', exp:'Safety.'},
                {q:'Passage: "Tit for Tat." Idea?', a:'Retaliation', w1:'Kindness', w2:'Love', w3:'Give', exp:'Revenge.'},
                {q:'Passage: "Actions speak louder..." Idea?', a:'Do, don\'t say', w1:'Talk', w2:'Shout', w3:'Silent', exp:'Proof.'},
                {q:'Passage: "Where there is a will..." Idea?', a:'Determination', w1:'Road', w2:'Wall', w3:'Stop', exp:'Success.'}
            ],
            'Cloze Test': [
                {q:'"Honesty is the ___ policy."', a:'best', w1:'worst', w2:'good', w3:'bad', exp:'Proverb.'},
                {q:'"A stitch in time saves ___."', a:'nine', w1:'one', w2:'ten', w3:'five', exp:'Proverb.'},
                {q:'"Prevention is better than ___."', a:'cure', w1:'care', w2:'sick', w3:'bad', exp:'Proverb.'},
                {q:'"All that glitters is not ___."', a:'gold', w1:'silver', w2:'iron', w3:'good', exp:'Proverb.'},
                {q:'"Make hay while the sun ___."', a:'shines', w1:'sets', w2:'rise', w3:'gone', exp:'Proverb.'},
                {q:'"Rome was not built in a ___."', a:'day', w1:'year', w2:'month', w3:'week', exp:'Proverb.'},
                {q:'"Where there is a will there is a ___."', a:'way', w1:'road', w2:'wall', w3:'path', exp:'Proverb.'},
                {q:'"Actions speak louder than ___."', a:'words', w1:'sound', w2:'voice', w3:'talk', exp:'Proverb.'},
                {q:'"Birds of a feather ___ together."', a:'flock', w1:'fly', w2:'sit', w3:'go', exp:'Proverb.'},
                {q:'"Charity begins at ___."', a:'home', w1:'school', w2:'work', w3:'church', exp:'Proverb.'},
                {q:'"Every cloud has a silver ___."', a:'lining', w1:'line', w2:'edge', w3:'color', exp:'Proverb.'},
                {q:'"Haste makes ___."', a:'waste', w1:'fast', w2:'speed', w3:'good', exp:'Proverb.'},
                {q:'"Knowledge is ___."', a:'power', w1:'good', w2:'bad', w3:'weak', exp:'Proverb.'},
                {q:'"Look before you ___."', a:'leap', w1:'jump', w2:'run', w3:'go', exp:'Proverb.'},
                {q:'"Practice makes a man ___."', a:'perfect', w1:'good', w2:'smart', w3:'rich', exp:'Proverb.'}
            ],
            'Sentence Rearrangement': [
                {q:'(A)is (B)He (C)boy', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'B-C-A', exp:'He is boy.'},
                {q:'(A)am (B)I (C)happy', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'B-C-A', exp:'I am happy.'},
                {q:'(A)Go (B)school (C)to', a:'A-C-B', w1:'B-A-C', w2:'C-A-B', w3:'B-C-A', exp:'Go to school.'},
                {q:'(A)plays (B)He (C)cricket', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'He plays cricket.'},
                {q:'(A)good (B)She (C)is', a:'B-C-A', w1:'A-B-C', w2:'C-A-B', w3:'B-A-C', exp:'She is good.'},
                {q:'(A)love (B)I (C)India', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'I love India.'},
                {q:'(A)sun (B)The (C)rises', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'The sun rises.'},
                {q:'(A)fast (B)Run (C)very', a:'B-C-A', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'Run very fast.'},
                {q:'(A)The (B)open (C)door', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'Open the door.'},
                {q:'(A)red (B)is (C)Rose', a:'C-B-A', w1:'A-B-C', w2:'B-A-C', w3:'A-C-B', exp:'Rose is red.'},
                {q:'(A)name (B)My (C)Ram (D)is', a:'B-A-D-C', w1:'A-B-C-D', w2:'D-A-B-C', w3:'C-D-A-B', exp:'My name is Ram.'},
                {q:'(A)late (B)is (C)He', a:'C-B-A', w1:'A-B-C', w2:'B-A-C', w3:'A-C-B', exp:'He is late.'},
                {q:'(A)tea (B)likes (C)She', a:'C-B-A', w1:'A-B-C', w2:'B-A-C', w3:'A-C-B', exp:'She likes tea.'},
                {q:'(A)can (B)I (C)swim', a:'B-A-C', w1:'A-B-C', w2:'C-A-B', w3:'A-C-B', exp:'I can swim.'},
                {q:'(A)honesty (B)Best (C)is', a:'A-C-B', w1:'B-A-C', w2:'C-A-B', w3:'B-C-A', exp:'Honesty is best.'}
            ]
        };

        // --- INSERT INTO DATABASE ---
        const topicList = Object.keys(questionBank);
        for (let t of topicList) {
            const questions = questionBank[t];
            for (let item of questions) {
                // Shuffle options
                let opts = shuffle([
                    { val: item.a, isCorrect: true },
                    { val: item.w1, isCorrect: false },
                    { val: item.w2, isCorrect: false },
                    { val: item.w3, isCorrect: false }
                ]);

                // Find correct option letter (A/B/C/D)
                let finalAns = 'A';
                if (opts[1].isCorrect) finalAns = 'B';
                if (opts[2].isCorrect) finalAns = 'C';
                if (opts[3].isCorrect) finalAns = 'D';

                await addQ(t, item.q, opts[0].val, opts[1].val, opts[2].val, opts[3].val, finalAns, item.exp);
            }
        }

        res.send(`<h1>✅ ENGLISH FIXED: ULTIMATE VERSION</h1><p>225 Unique Questions Loaded (15 per topic). <br><b>Quant & Reasoning are SAFE.</b></p><a href="/">Go to Dashboard</a>`);

    } catch(err) { res.send("Error: " + err.message); }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));