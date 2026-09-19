require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const ytSearch = require('yt-search');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

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

const catalogCache = new NodeCache({ stdTTL: 60 });
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
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=50`;
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
    { genre: "Eve", query: "Eve ooo0eve0ooo Kaikai Kitan official" },
    { genre: "Trío Los Panchos", query: "Trio Los Panchos Sabor a mi clasicos" },
    { genre: "Cuarteto de Nos", query: "Cuarteto de Nos Porfiado Raro" },
    { genre: "City Pop", query: "80s Japanese City Pop hits Tatsuro Yamashita" },
    { genre: "Post-Punk", query: "Molchat Doma Ploho Human Tetris Russian Post-Punk" },
    { genre: "Boleros", query: "Boleros del recuerdo clasicos inolvidables" },
    { genre: "Indie Rock", query: "Arctic Monkeys The Strokes Franz Ferdinand" },
    { genre: "Lofi Beats", query: "Lofi hip hop relaxing beats study chill" },
    { genre: "Anime OST", query: "Anime openings full official full soundtrack" },
    { genre: "J-Pop", query: "J-Pop top chart hits Yoasobi Ado Kenshi Yonezu" },
    { genre: "Phonk", query: "Drift phonk aggressive house Kordhell" },
    { genre: "Vocaloid", query: "Hatsune Miku Vocaloid original songs" },
    { genre: "Rock en Español", query: "Soda Stereo Enanitos Verdes Heroes del Silencio" }
];

async function sendDiscordSummary(addedSongs) {
    try {
        const channelId = process.env.DISCORD_CHANNEL_ID;
        if (!channelId) return;
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) return;

        const mainEmbed = new EmbedBuilder()
            .setTitle('🌙 Escaneo de Canciones Finalizado')
            .setDescription(`Se han procesado e insertado exitosamente **${addedSongs.length} nuevas canciones** sin duplicados.`)
            .setColor(0x7289da)
            .setTimestamp();

        await channel.send({ embeds: [mainEmbed] });

        const sampleSongs = addedSongs.slice(0, 5);
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
            await delay(300);
        }

        if (addedSongs.length > 5) {
            await channel.send(`*...y ${addedSongs.length - 5} canciones más registradas.*`);
        }
    } catch (e) {
        console.error('Error enviando reporte a Discord:', e.message);
    }
}

async function runSlowScraper(maxSongsTarget = 1000, customCategory = null) {
    if (isScraperRunning) return;
    isScraperRunning = true;
    console.log(`🚀 [SCRAPER] Iniciando proceso (Objetivo: ~${maxSongsTarget} canciones)...`);

    const addedSongs = [];
    const targets = customCategory 
        ? [{ genre: customCategory, query: customCategory }] 
        : searchTargets;

    try {
        for (const target of targets) {
            if (addedSongs.length >= maxSongsTarget) break;

            console.log(`⏳ Buscando: [${target.genre}] -> "${target.query}"`);

            const scTracks = await searchSoundCloud(target.query);
            await delay(1500); 

            const ytTracks = await searchYouTube(target.query);
            await delay(1500); 

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

            await delay(2500);
        }

        catalogCache.del('full_catalog');
        console.log(`🎉 [SCRAPER] Finalizado. Total agregadas: ${addedSongs.length}`);

        if (addedSongs.length > 0) {
            await sendDiscordSummary(addedSongs);
        }
    } catch (e) {
        console.error('Error en scraper:', e.message);
    } finally {
        isScraperRunning = false;
    }
}

cron.schedule('0 21,22,23,0,1,2,3,4,5,6 * * *', () => {
    console.log('⏰ Horario nocturno activado (9 PM - 6 AM). Iniciando ciclo de ingesta...');
    runSlowScraper(500);
});

// ESCUCHADOR DE COMANDOS COMPLETO EN DISCORD
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'status') {
        return message.reply(isScraperRunning 
            ? '🔄 El scraper está **activo** descargando canciones.' 
            : '🟢 El scraper está en **espera** (Inactivo).');
    }

    if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🤖 Comandos de Sekai Music Bot')
            .setColor(0x3498db)
            .addFields(
                { name: '!status', value: 'Muestra el estado del scraper.' },
                { name: '!stats', value: 'Muestra el número total real de canciones en la BD.' },
                { name: '!add [cant] [término]', value: 'Agrega canciones de un término. Ej: `!add 50 vocaloid`' },
                { name: '!search [nombre]', value: 'Busca canciones guardadas en el catálogo.' },
                { name: '!trigger', value: 'Fuerza la ejecución del scraper nocturno.' },
                { name: '!stop', value: 'Cancela la ejecución actual.' }
            );
        return message.reply({ embeds: [helpEmbed] });
    }

    if (command === 'stats') {
        const { count, error } = await supabase
            .from('songs')
            .select('*', { count: 'exact', head: true });
        
        if (error) return message.reply('❌ Error al obtener estadísticas.');
        return message.reply(`📊 Total en la base de datos: **${count} canciones**.`);
    }

    if (command === 'search') {
        const query = args.join(' ');
        if (!query) return message.reply('❌ Indica el nombre a buscar. Ej: `!search Eve`');

        const { data } = await supabase
            .from('songs')
            .select('title, artist, source')
            .or(`title.ilike.%${query}%,artist.ilike.%${query}%`)
            .limit(5);

        if (!data || data.length === 0) return message.reply('🔍 No se encontraron coincidencias.');

        const results = data.map((s, i) => `${i + 1}. **${s.title}** - ${s.artist} *(${s.source})*`).join('\n');
        return message.reply(`🎵 **Resultados:**\n${results}`);
    }

    if (command === 'trigger') {
        if (isScraperRunning) return message.reply('⚠️ El scraper ya se encuentra ejecutándose.');
        message.reply('🚀 Forzando inicio del scraper nocturno...');
        runSlowScraper(300);
    }

    if (command === 'add') {
        const limit = parseInt(args[0]) || 50;
        const category = args.slice(1).join(' ') || null;

        if (isScraperRunning) {
            return message.reply('⚠️ El scraper ya se encuentra ejecutando una descarga.');
        }

        message.reply(`🚀 Iniciando ingesta manual de hasta **${limit} canciones**${category ? ` para "${category}"` : ''}.`);
        runSlowScraper(limit, category);
    }
});

// ENDPOINTS API REST
app.get('/api/health', (req, res) => res.status(200).send('OK - Server Active'));

// ENDPOINT DE CATÁLOGO COMPLETO SIN LÍMITES
app.get('/api/v1/catalog', async (req, res) => {
    try {
        // Conteo Exacto sin traer filas
        const { count, error: countError } = await supabase
            .from('songs')
            .select('*', { count: 'exact', head: true });

        if (countError) return res.status(500).json({ status: 'error', message: countError.message });

        let allSongs = [];
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;

        // Paginación interna para superar el límite de 1000 de Supabase
        while (hasMore) {
            const { data, error } = await supabase
                .from('songs')
                .select('*')
                .range(page * pageSize, (page + 1) * pageSize - 1)
                .order('id', { ascending: false });

            if (error) return res.status(500).json({ status: 'error', message: error.message });

            allSongs = allSongs.concat(data);
            if (data.length < pageSize) {
                hasMore = false;
            } else {
                page++;
            }
        }

        res.json({
            status: 'success',
            server: RENDER_URL,
            total: count,
            fetched: allSongs.length,
            catalog: allSongs
        });
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
            .limit(100);

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

// =====================================================================
// NUEVO ENDPOINT: GENERADOR DE RESOURCE PACK (.MCPACK) PARA BEDROCK
// =====================================================================
app.post('/api/v1/generate-mcpack', async (req, res) => {
    try {
        const { song_ids } = req.body;
        
        if (!song_ids || !Array.isArray(song_ids) || song_ids.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Debes enviar un array de song_ids' });
        }

        // 1. Obtener los datos de las canciones desde la BD
        const { data: songs, error } = await supabase
            .from('songs')
            .select('*')
            .in('id', song_ids);

        if (error) throw new Error(error.message);

        // 2. Configurar la respuesta como un archivo descargable .mcpack
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="SekaiMusic.mcpack"');
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);

        // 3. Crear el manifest.json
        const manifest = {
            format_version: 2,
            header: {
                name: "🎵 Sekai Music Pack",
                description: "Música generada desde Sekai Music Server",
                uuid: uuidv4(),
                version: [1, 0, 0],
                min_engine_version: [1, 20, 0]
            },
            modules: [{
                type: "resources",
                uuid: uuidv4(),
                version: [1, 0, 0]
            }]
        };
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

        // 4. Crear el sound_definitions.json
        let soundDefinitions = { format_version: "1.14.0", sound_definitions: {} };

        for (const song of songs) {
            const internalName = `sekai.track_${song.id}`;
            soundDefinitions.sound_definitions[internalName] = {
                category: "record",
                sounds: [ { name: `sounds/sekai/${song.id}`, stream: true } ]
            };

            // AQUÍ: La lógica real para descargar el audio de YT/SoundCloud y convertirlo a OGG.
            // Pide a ChatGPT que integre ytdl-core + fluent-ffmpeg en esta sección.
            const dummyContent = `Audio temporal para: ${song.title} - ${song.artist}`; 
            archive.append(dummyContent, { name: `sounds/sekai/${song.id}.ogg` });
        }

        archive.append(JSON.stringify(soundDefinitions, null, 2), { name: 'sounds/sound_definitions.json' });

        // 5. Finalizar el empaquetado y enviarlo
        await archive.finalize();

    } catch (err) {
        console.error("Error generando mcpack:", err);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
});
// =====================================================================

app.listen(PORT, async () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    
    if (process.env.DISCORD_BOT_TOKEN) {
        try {
            await discordClient.login(process.env.DISCORD_BOT_TOKEN);
            console.log('🤖 Bot de Discord conectado exitosamente');
        } catch (error) {
            console.error('❌ Error al conectar el bot de Discord:', error.message);
        }
    }
});
