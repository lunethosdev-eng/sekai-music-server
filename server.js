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

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'TU_SUPABASE_URL';
const supabaseKey = process.env.SUPABASE_KEY || 'TU_SUPABASE_ANON_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

// Lista de Artistas a trackear
const targetArtists = [
    "Depresión Sonora", "Eve", "Laufey", "Grupo Frontera", "Al Hars", 
    "Kenshi Yonezu", "Arctic Monkeys", "Joji" // Añadidos extra
];

// 1. SISTEMA ANTI-SLEEP PARA RENDER (Ping cada 13 minutos)
setInterval(async () => {
    try {
        await axios.get(`${RENDER_URL}/api/health`);
        console.log('Ping interno ejecutado para mantener Render activo');
    } catch (error) {
        console.error('Error en ping interno', error.message);
    }
}, 13 * 60 * 1000); // 13 minutos

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// 2. CRON JOB: Scraping cada 4 horas
cron.schedule('0 */4 * * *', async () => {
    console.log('Iniciando búsqueda automática de música (SoundCloud/YouTube)...');
    for (const artist of targetArtists) {
        await scrapeAndUpload(artist);
    }
});

// Función central de scraping (Lógica estructural)
async function scrapeAndUpload(artist) {
    console.log(`Buscando canciones para: ${artist}...`);
    
    // Aquí iría la lógica de yt-dlp o soundcloud-scraper
    // MOCK: Simulando obtención de datos
    const mockSong = {
        title: `Canción de ${artist}`,
        artist: artist,
        duration: Math.floor(Math.random() * 200) + 20, // duración aleatoria
        source: 'soundcloud', // o youtube si falló soundcloud
        audio_url: 'url_al_audio_subido_a_supabase_storage',
        cover_url: 'url_al_cover',
        animated_cover: 'url_al_cover_animado',
        lyrics: '[00:10.00] Letra sincronizada...',
        artist_photo: 'url_foto_artista'
    };

    // Filtro: Descartar canciones menores a 60 segundos
    if (mockSong.duration < 60) {
        console.log(`❌ Descartada: ${mockSong.title} (Dura menos de 60s)`);
        return;
    }

    // Guardar en Supabase
    const { data, error } = await supabase.from('songs').insert([mockSong]);
    if (error) console.error(`Error guardando ${mockSong.title}:`, error);
    else console.log(`✅ Guardada: ${mockSong.title}`);
}

// 3. ENDPOINTS PARA OTRAS APPS (La Documentación API)
app.get('/api/songs', async (req, res) => {
    const { data, error } = await supabase.from('songs').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. ENDPOINT PARA SUBIDA MANUAL (Menú Secreto)
app.post('/api/upload', async (req, res) => {
    const { title, artist, duration, cover_url, audio_url, lyrics } = req.body;
    
    if (duration < 60) {
        return res.status(400).json({ error: "La canción no puede durar menos de 60 segundos" });
    }

    const { data, error } = await supabase.from('songs').insert([req.body]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: "Canción subida manualmente al catálogo" });
});

app.listen(PORT, () => {
    console.log(`Sekai Music Server corriendo en puerto ${PORT}`);
});
