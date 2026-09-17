require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const ytSearch = require('yt-search');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://sekai-music-server.onrender.com';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'sekai_secret_key_123';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const catalogCache = new NodeCache({ stdTTL: 300 });
let soundcloudClientId = 'iZea6V13B2S91I1B1i0x90nI0N6N9p6a';
let isScraperRunning = false;

// Configuración del Bot de Discord
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requireAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === ADMIN_API_KEY) return next();
    return res.status(401).json({ status: 'error', message: 'No autorizado.' });
};

async function getSoundCloudClientId() {
    try {
        const pageRes = await axios.get('https://soundcloud.com', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 5000
        });
        const jsUrls = pageRes.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g) || [];
        for (const url of jsUrls.slice(-4)) {
            const jsRes = await axios.get(url, { timeout: 5000 });
            const match = jsRes.data.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
            if (match && match[1]) {
                soundcloudClientId = match[1];
                return soundcloudClientId;
            }
        }
    } catch (e) {}
    return soundcloudClientId;
}

async function searchSoundCloud(query) {
    try {
        const clientId = await getSoundCloudClientId();
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=20`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 6000
        });

        if (res.data && res.data.collection) {
            return res.data.collection.map(t => ({
                title: t.title,
                artist: t.user ? t.user.username : 'SoundCloud Artist',
                duration: Math.floor((t.duration || 180000) / 1000),
                source: 'soundcloud',
                audio_url: t.permalink_url,
                cover_url: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : (t.user ? t.user.avatar_url : null)
            })).filter(t => t.duration >= 45 && t.audio_url);
        }
    } catch (e) {}
    return [];
}

async function searchYouTube(query) {
    try {
        const r = await ytSearch(query);
        const videos = r.videos || [];
        return videos.map(v => ({
            title: v.title,
            artist: v.author ? v.author.name.replace('VEVO', '').replace('- Topic', '').trim() : 'YouTube Artist',
            duration: v.duration.seconds,
            source: 'youtube',
            audio_url: v.url,
            cover_url: v.thumbnail
        })).filter(v => v.duration >= 45 && v.audio_url);
    } catch (e) {}
    return [];
}

const searchTargets = [
    { genre: "Eve", query: "Eve ooo0eve0ooo Kaikai Kitan" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Sabor a mi" },
    { genre: "Cuarteto de Nos", query: "Cuarteto de Nos Porfiado" },
    { genre: "City Pop", query: "80s Japanese City Pop hits" },
    { genre: "Post-Punk", query: "Molchat Doma Ploho Human Tetris" },
    { genre: "Boleros", query: "Boleros del recuerdo clasicos" },
    { genre: "Indie Rock", query: "Arctic Monkeys The Strokes" },
    { genre: "Lofi Beats", query: "Lofi hip hop relaxing beats" },
    { genre: "Anime OST", query: "Anime openings full official" },
    { genre: "J-Pop", query: "J-Pop top chart hits Yoasobi Ado" },
    { genre: "Phonk", query: "Drift phonk aggressive house" }
];

// Enviar resúmenes enriquecidos a Discord con portadas
async function sendDiscordSummary(addedSongs) {
    try {
        const channelId = process.env.DISCORD_CHANNEL_ID;
        if (!channelId) return;
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return;

        const mainEmbed = new EmbedBuilder()
            .setTitle('🌙 Escaneo Nocturno Finalizado')
            .setDescription(`Se han procesado e insertado exitosamente **${addedSongs.length} nuevas canciones** en la base de datos.`)
            .setColor(0x7289da)
            .setTimestamp();

        await channel.send({ embeds: [mainEmbed] });

        // Enviar tarjetas individuales con portadas de hasta las primeras 10 canciones agregadas
        const sampleSongs = addedSongs.slice(0, 10);
        for (const song of sampleSongs) {
            const songEmbed = new EmbedBuilder()
                .setTitle(song.title)
                .addFields(
                    { name: 'Artista', value: song.artist, inline: true },
                    { name: 'Género', value: song.genre, inline: true },
                    { name: 'Fuente', value: song.source, inline: true }
                )
                .setThumbnail(song.cover_url)
                .setColor(0x2ecc71);

            await channel.send({ embeds: [songEmbed] });
            await delay(500);
        }

        if (addedSongs.length > 10) {
            await channel.send(`*...y ${addedSongs.length - 10} canciones más agregadas a la base de datos.*`);
        }
    } catch (e) {
        console.error('Error enviando reporte a Discord:', e.message);
    }
}

// Scraper Lento (Pausas moderadas de 4s para evitar baneos)
async function runSlowScraper(maxSongsTarget = 1000) {
    if (isScraperRunning) return;
    isScraperRunning = true;
    console.log(`🚀 [SCRAPER NOCTURNO] Iniciando proceso lento (Objetivo: ~${maxSongsTarget} canciones)...`);

    const addedSongs = [];

    try {
        for (const target of searchTargets) {
            if (addedSongs.length >= maxSongsTarget) break;

            console.log(`⏳ Descargando lento: [${target.genre}] -> "${target.query}"`);

            const scTracks = await searchSoundCloud(target.query);
            await delay(2000); 

            const ytTracks = await searchYouTube(target.query);
            await delay(2000); 

            const allTracks = [...scTracks, ...ytTracks];
            const batchToInsert = [];

            for (const track of allTracks) {
                const cleanTitle = track.title
                    .replace(/\[.*\]|\(.*\)/g, '')
                    .replace(/Official Video|Official Audio|Video Oficial|Lyric Video|Audio|4K|HD|Remastered/gi, '')
                    .trim();

                batchToInsert.push({
                    title: cleanTitle || track.title,
                    artist: track.artist || target.genre,
                    genre: target.genre,
                    duration: track.duration,
                    source: track.source,
                    audio_url: track.audio_url,
                    cover_url: track.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500&q=80',
                    lyrics: "[00:00.00] Letra no disponible"
                });
            }

            if (batchToInsert.length > 0) {
                const { data, error } = await supabase
                    .from('songs')
                    .upsert(batchToInsert, { onConflict: 'audio_url', ignoreDuplicates: true })
                    .select();

                if (!error && data) {
                    addedSongs.push(...data);
                    console.log(`✅ +${data.length} agregadas de [${target.genre}]. Total sesión: ${addedSongs.length}`);
                }
            }

            // Descarga muy lenta: Pausa de 4 segundos entre cada término de búsqueda
            await delay(4000);
        }

        catalogCache.del('full_catalog');
        console.log(`🎉 [SCRAPER] Finalizado. Total agregadas: ${addedSongs.length}`);

        if (addedSongs.length > 0) {
            await sendDiscordSummary(addedSongs);
        }
    } catch (e) {
        console.error('Error en scraper nocturno:', e.message);
    } finally {
        isScraperRunning = false;
    }
}

// PROGRAMACIÓN: Ejecutar AUTOMÁTICAMENTE desde las 9 PM hasta las 6 AM cada hora
// Formato cron: Minuto 0, en las horas 21,22,23,0,1,2,3,4,5,6
cron.schedule('0 21,22,23,0,1,2,3,4,5,6 * * *', () => {
    console.log('⏰ Horario nocturno activado (9 PM - 6 AM). Iniciando ciclo de descarga lenta...');
    runSlowScraper(300);
});

// ESCUCHADOR DE COMANDOS EN DISCORD
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Comando: !add 1000 music
    if (message.content.startsWith('!add')) {
        const args = message.content.split(' ');
        const limit = parseInt(args[1]) || 100;

        if (isScraperRunning) {
            return message.reply('⚠️ El scraper ya se encuentra ejecutando una descarga en este momento.');
        }

        message.reply(`🚀 Iniciando descarga lenta manual de hasta **${limit} canciones**. Te avisaré por aquí al terminar con los detalles.`);
        runSlowScraper(limit);
    }

    // Comando: !status
    if (message.content === '!status') {
        message.reply(isScraperRunning 
            ? '🔄 El scraper está **activo** descargando canciones lentamente.' 
            : '🟢 El scraper está en **espera** (Inactivo).');
    }
});

// ENDPOINTS API REST
app.get('/api/health', (req, res) => res.status(200).send('OK - Server Active'));

app.get('/api/v1/catalog', async (req, res) => {
    try {
        const cachedCatalog = catalogCache.get('full_catalog');
        if (cachedCatalog) {
            return res.json({ status: 'success', server: RENDER_URL, cached: true, total: cachedCatalog.length, catalog: cachedCatalog });
        }

        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .range(0, 9999)
            .order('id', { ascending: false });

        if (error) return res.status(500).json({ status: 'error', message: error.message });

        catalogCache.set('full_catalog', data);
        res.json({ status: 'success', server: RENDER_URL, cached: false, total: data.length, catalog: data });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/v1/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ status: 'error', message: 'Falta parámetro ?q=' });

        const { data, error } = await supabase
            .from('songs')
            .select('*')
            .or(`title.ilike.%${q}%,artist.ilike.%${q}%,genre.ilike.%${q}%`)
            .limit(50);

        if (error) return res.status(500).json({ status: 'error', message: error.message });
        res.json({ status: 'success', total: data.length, results: data });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/upload', requireAuth, async (req, res) => {
    try {
        const { title, artist, duration, audio_url, cover_url, lyrics, genre } = req.body;
        const songData = {
            title, artist, genre: genre || 'General',
            duration: parseInt(duration) || 180, source: 'manual',
            audio_url: audio_url || '', cover_url: cover_url || '', lyrics: lyrics || null
        };
        const { data, error } = await supabase.from('songs').insert([songData]).select();
        if (error) return res.status(500).json({ error: error.message });

        catalogCache.del('full_catalog');
        res.json({ success: true, song: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, async () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    if (process.env.DISCORD_BOT_TOKEN) {
        await discordClient.login(process.env.DISCORD_BOT_TOKEN);
        console.log('🤖 Bot de Discord conectado exitosamente');
    }
});
