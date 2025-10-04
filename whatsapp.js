// whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const express = require('express');
const app = express();
const port = 3000;

// ------------------------
// ✅ MySQL pool
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '', // your DB password
    database: 'project_attendance_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ------------------------
// ✅ WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: false } // set true after first login
});

// ------------------------
// QR code login
client.on('qr', qr => {
    console.log('Scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// WhatsApp ready
client.on('ready', () => console.log('✅ WhatsApp client ready'));
client.initialize();

// ------------------------
// ✅ Notify a single student
app.get('/notify', async (req, res) => {
    const { reg_no } = req.query;
    if (!reg_no) return res.send('❌ Missing reg_no');

    try {
        const [rows] = await pool.execute(`
            SELECT a.status, a.notify_status, s.firstname, s.lastname, s.contact
            FROM attende a
            JOIN student s ON a.reg_no = s.reg_no
            WHERE a.reg_no = ? AND a.date = CURDATE()
        `, [reg_no]);

        if (rows.length === 0) return res.send('❌ No attendance record today');

        const record = rows[0];

        if (record.notify_status === 'sent') return res.send('✅ Parent already notified');
        if (!record.contact) return res.send('❌ No parent contact');

        const parent_number = record.contact + '@c.us';
        const messageText = `${record.firstname} ${record.lastname} is marked ${record.status} today (${new Date().toISOString().slice(0,10)})`;

        try {
            await client.sendMessage(parent_number, messageText);

            // ✅ Update DB to sent
            await pool.execute(
                "UPDATE attende SET notify_status='sent' WHERE reg_no=? AND date=CURDATE()",
                [reg_no]
            );

            res.send('✅ Parent notified and DB updated!');
        } catch(err) {
            console.error('WhatsApp send error:', err);

            // ✅ Update DB to failed
            await pool.execute(
                "UPDATE attende SET notify_status='failed' WHERE reg_no=? AND date=CURDATE()",
                [reg_no]
            );

            res.send('❌ Failed to send message, DB updated to failed');
        }

    } catch(err){
        console.error(err);
        res.send('❌ Error processing request');
    }
});

// ------------------------
// ✅ Notify all pending students
app.get('/notify_all', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT a.reg_no, a.status, a.notify_status, s.firstname, s.lastname, s.contact
            FROM attende a
            JOIN student s ON a.reg_no = s.reg_no
            WHERE a.date = CURDATE() AND a.notify_status='pending'
        `);

        if(rows.length === 0) return res.send('No pending notifications');

        let successCount = 0;
        let failCount = 0;

        for(const record of rows){
            if(!record.contact){
                failCount++;
                continue; // skip if no contact
            }

            const parent_number = record.contact + '@c.us';
            const messageText = `${record.firstname} ${record.lastname} is marked ${record.status} today (${new Date().toISOString().slice(0,10)})`;

            try{
                await client.sendMessage(parent_number, messageText);

                // ✅ Update notify_status to sent
                await pool.execute(
                    "UPDATE attende SET notify_status='sent' WHERE reg_no=? AND date=CURDATE()",
                    [record.reg_no]
                );

                successCount++;

                // Small delay to avoid WhatsApp blocking
                await new Promise(resolve => setTimeout(resolve, 500)); // 0.5s
            }catch(err){
                console.error(`Failed to send message to ${record.reg_no}`, err);

                await pool.execute(
                    "UPDATE attende SET notify_status='failed' WHERE reg_no=? AND date=CURDATE()",
                    [record.reg_no]
                );

                failCount++;
            }
        }

        res.send(`✅ Sent: ${successCount}, ❌ Failed: ${failCount}`);
    } catch(err){
        console.error(err);
        res.send('❌ Error sending messages');
    }
});

// ------------------------
// Start API server
app.listen(port, () => console.log(`Bot API running on port ${port}`));
