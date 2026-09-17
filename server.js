require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;

// Configuración de Supabase usando SERVICE_ROLE para permisos completos en el servidor
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const targetArtists = [
    "Depresión Sonora", "Eve", "Laufey", "Grupo Frontera", "Al Hars", 
    "Kenshi Yonezu", "Arctic Monkeys", "Joji"
];

// Anti-sleep para Render (Ping cada 13 min)
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('Ping interno ejecutado');
    } catch (error) {
        console.error('Error en ping interno:', error.message);
    }
}, 13 * 60 * 1000);

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// Cron Job: Scraping cada 4 horas
cron.schedule('0 */4 * * *', async () => {
    console.log('Ejecutando cron job de scraping...');
    for (const artist of targetArtists) {
        await scrapeAndUpload(artist);
    }
});

async function scrapeAndUpload(artist) {
    const mockSong = {
        title: `Canción de ${artist}`,
        artist: artist,
        duration: 180,
        source: 'soundcloud',
        audio_url: 'https://ejemplo.com/audio.mp3',
        cover_url: 'https://ejemplo.com/cover.jpg',
        lyrics: '[00:10.00] Letra...'
    };

    if (mockSong.duration < 60) {
        console.log(`Descartada por duración corta: ${mockSong.title}`);
        return;
    }

    const { data, error } = await supabase.from('songs').insert([mockSong]);
    if (error) console.error(`Error guardando ${mockSong.title}:`, error.message);
    else console.log(`Guardada en DB: ${mockSong.title}`);
}

// Endpoints API
app.get('/api/songs', async (req, res) => {
    const { data, error } = await supabase.from('songs').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/upload', async (req, res) => {
    const { duration } = req.body;
    if (duration < 60) {
        return res.status(400).json({ error: "La canción dura menos de 60 segundos" });
    }

    const { data, error } = await supabase.from('songs').insert([req.body]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: "Canción guardada con éxito" });
});

app.listen(PORT, () => {
    console.log(`Sekai Music Server corriendo en puerto ${PORT}`);
});
