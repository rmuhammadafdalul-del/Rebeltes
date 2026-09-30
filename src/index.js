require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  SlashCommandBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`ENV ${key} belum diisi.`);
    process.exit(1);
  }
}

const cfg = {
  guildId: process.env.GUILD_ID,
  staffRoleId: process.env.STAFF_ROLE_ID || '',
  supportCategoryId: process.env.SUPPORT_CATEGORY_ID || '',
  createTicketChannelId: process.env.CREATE_TICKET_CHANNEL_ID || '',
  createTicketChannelName: process.env.CREATE_TICKET_CHANNEL_NAME || 'create-ticket',
  donationCategoryId: process.env.SUPPORT_TICKET_CATEGORY_ID || process.env.DONATION_CATEGORY_ID || '',
  reportCategoryId: process.env.REPORT_CATEGORY_ID || '',
  formCategoryId: process.env.FORM_CATEGORY_ID || '',
  logChannelId: process.env.LOG_CHANNEL_ID || '',
  donationTimeoutHours: Number(process.env.DONATION_TIMEOUT_HOURS || 24),
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || '',
  goodbyeChannelId: process.env.GOODBYE_CHANNEL_ID || '',
  welcomeImage: process.env.WELCOME_IMAGE_URL || '',
  goodbyeImage: process.env.GOODBYE_IMAGE_URL || '',
  welcomeMessage: process.env.WELCOME_MESSAGE || 'Selamat datang {user} di server!',
  goodbyeMessage: process.env.GOODBYE_MESSAGE || 'See you {user}, semoga sukses!',
  rolePanelChannelId: process.env.ROLE_PANEL_CHANNEL_ID || '',
  wargaRoleId: process.env.ROLE_WARGA_ID || ''
};
const donationTimeoutMs = cfg.donationTimeoutHours * 60 * 60 * 1000;

function parseRoleButtons(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(item => {
      const [label, roleId, emoji = '🎭'] = item.split('|').map(x => x.trim());
      return { label, roleId, emoji };
    })
    .filter(x => x.label && /^\d{17,20}$/.test(x.roleId));
}
const roleButtons = parseRoleButtons(process.env.ROLE_BUTTONS);

const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'tickets.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    ticket_number INTEGER NOT NULL,
    channel_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    donation_confirmed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(guild_id, status);
  CREATE TABLE IF NOT EXISTS counters (
    guild_id TEXT PRIMARY KEY,
    ticket_number INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS setup_settings (
    guild_id TEXT PRIMARY KEY,
    welcome_enabled INTEGER NOT NULL DEFAULT 0,
    goodbye_enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ticket_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    ticket_number INTEGER NOT NULL,
    channel_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    ticket_type TEXT NOT NULL,
    rating INTEGER,
    comment TEXT,
    created_at INTEGER NOT NULL,
    submitted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_user ON ticket_feedback(user_id, submitted_at);
`);

const insertTicket = db.prepare(`INSERT INTO tickets
  (guild_id, ticket_number, channel_id, user_id, type, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`);
const getTicket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?');
const updateTicket = db.prepare(`UPDATE tickets SET status = ?, updated_at = ?, donation_confirmed_at = ? WHERE channel_id = ?`);
const expiredDonations = db.prepare(`SELECT * FROM tickets WHERE type IN ('donation', 'support') AND status = 'open' AND created_at <= ?`);
const createFeedbackRequest = db.prepare(`INSERT OR IGNORE INTO ticket_feedback
  (guild_id, ticket_number, channel_id, user_id, ticket_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
const getFeedbackRequest = db.prepare('SELECT * FROM ticket_feedback WHERE channel_id = ?');
const getPendingFeedback = db.prepare('SELECT * FROM ticket_feedback WHERE channel_id = ? AND user_id = ? AND submitted_at IS NULL');
const saveFeedbackRating = db.prepare('UPDATE ticket_feedback SET rating = ? WHERE id = ? AND user_id = ? AND submitted_at IS NULL');
const submitFeedback = db.prepare('UPDATE ticket_feedback SET comment = ?, submitted_at = ? WHERE id = ? AND user_id = ? AND submitted_at IS NULL');
const nextCounter = db.transaction(guildId => {
  const row = db.prepare('SELECT ticket_number FROM counters WHERE guild_id = ?').get(guildId);
  const next = (row?.ticket_number || 0) + 1;
  db.prepare(`INSERT INTO counters(guild_id, ticket_number) VALUES(?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET ticket_number = excluded.ticket_number`).run(guildId, next);
  return next;
});

function setSetupFlag(guildId, flag, enabled = 1) {
  db.prepare(`INSERT INTO setup_settings(guild_id, welcome_enabled, goodbye_enabled) VALUES(?, 0, 0)
    ON CONFLICT(guild_id) DO NOTHING`).run(guildId);
  db.prepare(`UPDATE setup_settings SET ${flag} = ? WHERE guild_id = ?`).run(enabled ? 1 : 0, guildId);
}

function isSetupEnabled(guildId, flag) {
  const row = db.prepare('SELECT welcome_enabled, goodbye_enabled FROM setup_settings WHERE guild_id = ?').get(guildId);
  return Boolean(row?.[flag]);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function isStaff(member) {
  return Boolean(cfg.staffRoleId && member?.roles?.cache?.has(cfg.staffRoleId));
}

function replaceVars(template, memberOrUser) {
  const user = memberOrUser?.user || memberOrUser;
  const id = user?.id || '';
  const mention = id ? `<@${id}>` : (user?.username || 'member');
  const username = user?.username || memberOrUser?.displayName || 'member';
  return template.replaceAll('{user}', mention).replaceAll('{username}', username);
}

function validId(value) {
  return /^\d{17,20}$/.test(String(value || ''));
}

async function getTextChannelById(guild, id) {
  if (!validId(id)) return null;
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return channel?.type === ChannelType.GuildText ? channel : null;
}

async function getCategoryById(guild, id, label) {
  if (!validId(id)) throw new Error(`${label} belum diisi dengan ID Discord yang valid.`);
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildCategory) {
    throw new Error(`${label} tidak ditemukan atau bukan kategori Discord.`);
  }
  return channel;
}

async function getOrCreateSetupChannel(guild) {
  if (cfg.createTicketChannelId) {
    const channel = await getTextChannelById(guild, cfg.createTicketChannelId);
    if (!channel) throw new Error('CREATE_TICKET_CHANNEL_ID tidak ditemukan atau bukan channel text.');
    if (channel.parentId !== cfg.supportCategoryId) {
      throw new Error('CREATE_TICKET_CHANNEL_ID bukan berada di SUPPORT_CATEGORY_ID. Pindahkan channel ke kategori Support atau perbaiki ID.');
    }
    return channel;
  }
  const category = await getCategoryById(guild, cfg.supportCategoryId, 'SUPPORT_CATEGORY_ID');
  let channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === cfg.createTicketChannelName && c.parentId === category.id);
  if (!channel) {
    channel = await guild.channels.create({ name: cfg.createTicketChannelName, type: ChannelType.GuildText, parent: category.id });
  }
  return channel;
}

async function logAction(guild, title, description) {
  const channel = await getTextChannelById(guild, cfg.logChannelId);
  if (!channel) return;
  await channel.send({
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp()]
  }).catch(() => {});
}

function ticketCategoryId(type) {
  return type === 'support' || type === 'donation' ? cfg.donationCategoryId : type === 'report' ? cfg.reportCategoryId : cfg.formCategoryId;
}

function ticketLabel(type) {
  return type === 'support' || type === 'donation' ? '🛟 TIKET DUKUNGAN' : type === 'report' ? '📢 TIKET REPORT' : '📝 TIKET FORMULIR';
}

function supportEmbed() {
  return new EmbedBuilder()
    .setTitle('🎫 SUPPORT CENTER')
    .setDescription(
      'Silakan pilih layanan yang kamu perlukan.\n\n' +
      '📢 **Report** — membuat tiket laporan.\n' +
      '📝 **Formulir** — mengisi formulir.\n' +
      '🛟 **Dukungan** — membuat tiket dukungan dengan fitur yang sama seperti tiket donasi dan dapat mengirim bukti pembayaran.\n\n' +
      `⏳ Tiket dukungan yang belum dikonfirmasi akan otomatis dihapus setelah **${cfg.donationTimeoutHours} jam**.`
    )
    .setFooter({ text: 'Admin / Helper akan memproses tiket.' });
}
function supportRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_report').setLabel('Report').setEmoji('📢').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('open_form').setLabel('Formulir').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('open_support').setLabel('Dukungan').setEmoji('🛟').setStyle(ButtonStyle.Success)
  )];
}

function roleEmbed() {
  return new EmbedBuilder()
    .setTitle('🎭 PENGAMBILAN ROLE WARGA')
    .setDescription('Klik tombol **Warga** untuk mengambil role warga. Role lain yang dikonfigurasi juga tersedia di bawah. Klik lagi untuk melepas role yang sama.')
    .setFooter({ text: 'Role diberikan/dilepas otomatis.' });
}
function roleRows() {
  const items = [];
  if (validId(cfg.wargaRoleId)) items.push({ label: 'Warga', roleId: cfg.wargaRoleId, emoji: '👤' });
  items.push(...roleButtons);
  const rows = [];
  for (let i = 0; i < items.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder();
    for (const item of items.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder()
        .setCustomId(`selfrole:${item.roleId}`)
        .setLabel(item.label.slice(0, 80))
        .setEmoji(item.emoji)
        .setStyle(item.label === 'Warga' ? ButtonStyle.Success : ButtonStyle.Secondary));
    }
    rows.push(row);
  }
  return rows;
}

function reportModal(category = '📦 Lainnya') {
  return new ModalBuilder().setCustomId(`modal_report:${category}`).setTitle('Report').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Kategori laporan').setStyle(TextInputStyle.Short).setValue(category).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Judul laporan').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Jelaskan laporan').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('evidence').setLabel('Bukti / ID terkait (opsional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))
  );
}
function formModal(category = '📦 Formulir Lainnya') {
  return new ModalBuilder().setCustomId(`modal_form:${category}`).setTitle('Formulir').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Jenis formulir').setStyle(TextInputStyle.Short).setValue(category).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nama').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('contact').setLabel('Kontak / ID Discord').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('purpose').setLabel('Keperluan').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000))
  );
}

function ticketSelectionMenu(customId, placeholder, options) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);
  for (const option of options) {
    menu.addOptions(new StringSelectMenuOptionBuilder()
      .setLabel(option.label)
      .setDescription(option.description)
      .setEmoji(option.emoji)
      .setValue(option.value));
  }
  return new ActionRowBuilder().addComponents(menu);
}

function reportCategoryMessage() {
  return {
    content:
      '📢 **PENGAMBILAN TIKET REPORT**\n\n' +
      'Silakan pilih kategori laporan sesuai dengan keperluanmu:\n\n' +
      '👤 **Laporan Player**\nUntuk melaporkan player terkait perilaku atau pelanggaran aturan.\n\n' +
      '🐛 **Bug / Error**\nUntuk melaporkan bug, error, atau masalah pada sistem/server.\n\n' +
      '🛡️ **Laporan Staff**\nUntuk laporan atau keluhan terkait Staff/Worker.\n\n' +
      '📦 **Lainnya**\nUntuk laporan yang tidak termasuk dalam kategori di atas.\n\n' +
      '📌 Pastikan memilih kategori yang paling sesuai agar laporan dapat ditangani oleh Worker/Admin yang tepat.\n\n' +
      '💙 Terima kasih sudah membantu menjaga server tetap nyaman!',
    components: [ticketSelectionMenu('report_category_select', '📢 Pilih kategori report', [
      { label: 'Laporan Player', description: 'Laporan perilaku atau pelanggaran player.', emoji: '👤', value: 'player' },
      { label: 'Bug / Error', description: 'Laporkan bug, error, atau masalah sistem.', emoji: '🐛', value: 'bug' },
      { label: 'Laporan Staff', description: 'Laporan atau keluhan terkait Staff/Worker.', emoji: '🛡️', value: 'staff' },
      { label: 'Lainnya', description: 'Laporan di luar kategori lainnya.', emoji: '📦', value: 'other' }
    ])]
  };
}

function formCategoryMessage() {
  return {
    content:
      '📝 **PENGAMBILAN TIKET FORMULIR**\n\n' +
      'Silakan pilih jenis formulir sesuai dengan keperluanmu:\n\n' +
      '👥 **Pendaftaran / Pengajuan**\nUntuk pendaftaran atau pengajuan yang tersedia di server.\n\n' +
      '💼 **Recruitment / Worker**\nUntuk pengajuan menjadi Worker/Staff atau kebutuhan recruitment.\n\n' +
      '🤝 **Partnership / Kolaborasi**\nUntuk pengajuan partnership atau kolaborasi.\n\n' +
      '📦 **Formulir Lainnya**\nUntuk kebutuhan formulir yang tidak termasuk dalam kategori di atas.\n\n' +
      '📌 Pilih jenis formulir yang paling sesuai agar pengajuan dapat diproses dengan tepat.\n\n' +
      '💙 Terima kasih atas pengajuanmu!',
    components: [ticketSelectionMenu('form_category_select', '📝 Pilih jenis formulir', [
      { label: 'Pendaftaran / Pengajuan', description: 'Pendaftaran atau pengajuan yang tersedia di server.', emoji: '👥', value: 'application' },
      { label: 'Recruitment / Worker', description: 'Pengajuan menjadi Worker/Staff atau recruitment.', emoji: '💼', value: 'recruitment' },
      { label: 'Partnership / Kolaborasi', description: 'Pengajuan partnership atau kolaborasi.', emoji: '🤝', value: 'partnership' },
      { label: 'Formulir Lainnya', description: 'Kebutuhan formulir di luar kategori lainnya.', emoji: '📦', value: 'other' }
    ])]
  };
}

function reportCategoryLabel(key) {
  return {
    player: '👤 Laporan Player',
    bug: '🐛 Bug / Error',
    staff: '🛡️ Laporan Staff',
    other: '📦 Lainnya'
  }[key] || '📦 Lainnya';
}

function formCategoryLabel(key) {
  return {
    application: '👥 Pendaftaran / Pengajuan',
    recruitment: '💼 Recruitment / Worker',
    partnership: '🤝 Partnership / Kolaborasi',
    other: '📦 Formulir Lainnya'
  }[key] || '📦 Formulir Lainnya';
}

function supportModal(category = 'Keperluan Lainnya') {
  const modal = new ModalBuilder()
    .setCustomId(`modal_support:${category}`)
    .setTitle('Form Dukungan');

  return modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('category')
        .setLabel('Kategori')
        .setStyle(TextInputStyle.Short)
        .setValue(category)
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Nominal / Nilai')
        .setPlaceholder('Contoh: 50000')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(30)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('method')
        .setLabel('Metode pembayaran / bentuk kerja sama')
        .setPlaceholder('Transfer / E-wallet / Jelaskan bentuk kerja sama')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('note')
        .setLabel('Catatan (opsional)')
        .setPlaceholder('Jelaskan kebutuhanmu...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
    )
  );
}

function supportCategoryMessage() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('support_category_select')
    .setPlaceholder('🎫 Pilih kategori tiket')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Pembelian Subscription')
        .setDescription('Pembelian, perpanjangan, atau informasi subscription.')
        .setEmoji('💳')
        .setValue('subscription'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Investasi Item Game')
        .setDescription('Pembelian, penjualan, investasi, atau item game.')
        .setEmoji('🎮')
        .setValue('game_item'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Kerja Sama / Partnership')
        .setDescription('Pengajuan kerja sama, partnership, atau kolaborasi.')
        .setEmoji('🤝')
        .setValue('partnership'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Keperluan Lainnya')
        .setDescription('Pertanyaan atau kebutuhan di luar kategori lainnya.')
        .setEmoji('📦')
        .setValue('other')
    );

  return {
    content:
      '🎫 **PENGAMBILAN TIKET DUKUNGAN**\n\n' +
      'Silakan pilih kategori tiket sesuai dengan keperluanmu:\n\n' +
      '💳 **Pembelian Subscription**\n' +
      'Untuk pembelian, perpanjangan, atau informasi terkait subscription.\n\n' +
      '🎮 **Investasi Item Game**\n' +
      'Untuk pembelian, penjualan, investasi, atau pembahasan item dalam game.\n\n' +
      '🤝 **Kerja Sama / Partnership**\n' +
      'Untuk pengajuan kerja sama, partnership, maupun kolaborasi.\n\n' +
      '📦 **Keperluan Lainnya**\n' +
      'Untuk pertanyaan atau kebutuhan yang tidak termasuk dalam kategori di atas.\n\n' +
      '📌 Pastikan memilih kategori yang paling sesuai agar tiket dapat ditangani oleh Worker/Admin yang tepat.\n\n' +
      '💙 Terima kasih atas kepercayaan dan dukunganmu!',
    components: [new ActionRowBuilder().addComponents(menu)]
  };
}
function supportCategoryLabel(key) {
  return {
    subscription: '💳 Pembelian Subscription',
    game_item: '🎮 Investasi Item Game',
    partnership: '🤝 Kerja Sama / Partnership',
    other: '📦 Keperluan Lainnya'
  }[key] || '📦 Keperluan Lainnya';
}

async function createTicket(interaction, type, details) {
  // Multi-ticket: tidak ada pembatasan satu tiket per user.
  const category = await getCategoryById(interaction.guild, ticketCategoryId(type), (type === 'support' || type === 'donation') ? 'SUPPORT_TICKET_CATEGORY_ID / DONATION_CATEGORY_ID' : type === 'report' ? 'REPORT_CATEGORY_ID' : 'FORM_CATEGORY_ID');
  const staffRole = cfg.staffRoleId ? interaction.guild.roles.cache.get(cfg.staffRoleId) : null;
  const staffRoles = staffRole ? [staffRole] : [];
  // Semua member server dapat melihat dan membaca semua tiket.
  // Hanya customer pemilik tiket dan Staff yang dapat mengirim pesan.
  const overwrites = [
    { id: interaction.guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles] },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: interaction.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.AttachFiles] }
  ];
  for (const role of staffRoles) overwrites.push({
    id: role.id,
    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles]
  });

  const number = nextCounter(interaction.guild.id);
  const ticketNumber = String(number).padStart(4, '0');
  const channel = await interaction.guild.channels.create({
    name: `ticket-${ticketNumber}`,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    topic: `Ticket #${ticketNumber} | ${type} | User ${interaction.user.id}`
  });
  const now = Date.now();
  insertTicket.run(interaction.guild.id, number, channel.id, interaction.user.id, type, now, now);

  const timeoutText = (type === 'support' || type === 'donation')
    ? `\n⏳ **Batas konfirmasi: ${cfg.donationTimeoutHours} jam sejak tiket dibuat.**\nKirim **bukti pembayaran sebagai gambar/file** di channel ini.\n`
    : '';
  const embed = new EmbedBuilder()
    .setTitle(`${ticketLabel(type)} • #${ticketNumber}`)
    .setDescription(`Halo <@${interaction.user.id}>.\n\n**Data tiket:**\n${details}${timeoutText}\nAdmin/Helper akan memproses tiket ini.`)
    .setTimestamp();
  const row = (type === 'support' || type === 'donation')
    ? new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('staff_confirm_donation').setLabel('Confirm Dukungan').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('staff_reject_donation').setLabel('Reject Dukungan').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Tutup Tiket').setStyle(ButtonStyle.Secondary))
    : new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('staff_confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('staff_reject').setLabel('Reject').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Tutup Tiket').setStyle(ButtonStyle.Secondary));

  const supportWelcomeMessage = `💙・DUKUNGAN SERVER

Terima kasih sudah berkunjung dan ingin memberikan dukungan untuk server kami! 🙏

Melalui tiket ini, kamu dapat menghubungi kami untuk berbagai bentuk dukungan, seperti:

💰 Donasi Server
Bantu mendukung perkembangan dan kebutuhan server agar tetap aktif dan berkembang.

🎮 Investasi Item Game
Ingin melakukan investasi atau kerja sama terkait item dalam game? Silakan sampaikan detailnya melalui tiket.

🤝 Dukungan & Kerja Sama
Punya tawaran kerja sama, bantuan, atau bentuk dukungan lainnya? Kami siap mendiskusikannya.

📦 Keperluan Lainnya
Jika bentuk dukunganmu tidak termasuk di atas, tetap bisa menghubungi kami melalui tiket.

«📌 Silakan jelaskan keperluanmu dengan lengkap setelah membuat tiket agar Worker/Admin dapat membantu dengan lebih cepat.»

🙏 Setiap dukungan yang diberikan sangat berarti bagi perkembangan server kami.
Terima kasih sudah menjadi bagian dari komunitas kami! 💙`;

  if (type === 'support' || type === 'donation') {
    await channel.send({
      content: supportWelcomeMessage,
      allowedMentions: { parse: [] }
    });
  }
  await channel.send({ content: `${staffRoles.map(r => `<@&${r.id}>`).join(' ')} <@${interaction.user.id}>`, embeds: [embed], components: [row] });
  await interaction.reply({ content: `Tiket **#${ticketNumber}** berhasil dibuat: ${channel}`, ephemeral: true });
  await logAction(interaction.guild, '🎫 Tiket Dibuat', `Nomor: **#${ticketNumber}**\nUser: <@${interaction.user.id}>\nTipe: **${type}**\nChannel: ${channel}`);
}

async function sendFeedbackRequest(guild, ticket, reason) {
  createFeedbackRequest.run(
    guild.id,
    ticket.ticket_number,
    ticket.channel_id,
    ticket.user_id,
    ticket.type,
    Date.now()
  );
  const user = await client.users.fetch(ticket.user_id).catch(() => null);
  if (!user) return false;
  const ticketName = `#${String(ticket.ticket_number).padStart(4, '0')}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`feedback:${ticket.channel_id}:1`).setLabel('1 ⭐').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`feedback:${ticket.channel_id}:2`).setLabel('2 ⭐').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`feedback:${ticket.channel_id}:3`).setLabel('3 ⭐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`feedback:${ticket.channel_id}:4`).setLabel('4 ⭐').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`feedback:${ticket.channel_id}:5`).setLabel('5 ⭐').setStyle(ButtonStyle.Success)
  );
  await user.send({
    embeds: [new EmbedBuilder()
      .setTitle('⭐ Feedback Tiket')
      .setDescription(`Tiket **${ticketName}** sudah ditutup.\n\nBerikan penilaian **1–5 bintang** untuk pelayanan Admin/Helper.\nAlasan penutupan: **${reason}**`)
      .setFooter({ text: 'Setelah memilih rating, kamu bisa menambahkan komentar.' })
      .setTimestamp()],
    components: [row]
  }).catch(() => {});
  return true;
}

async function closeTicket(channel, reason, actorId) {
  const ticket = getTicket.get(channel.id);
  if (!ticket) return;
  updateTicket.run('closed', Date.now(), ticket.donation_confirmed_at || null, channel.id);
  await logAction(channel.guild, '🗑️ Tiket Ditutup', `Channel: <#${channel.id}>\nAlasan: ${reason}\nOleh: <@${actorId}>`);
  await sendFeedbackRequest(channel.guild, ticket, reason);
  await channel.delete(`Ticket closed: ${reason}`).catch(() => {});
}
async function ensureSupportPanel(guild) {
  const channel = await getOrCreateSetupChannel(guild);
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const alreadyPosted = messages?.some(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === '🎫 SUPPORT CENTER' && m.components?.length);
  if (!alreadyPosted) {
    await channel.send({ embeds: [supportEmbed()], components: supportRows() });
  }
  return channel;
}

async function ensureRolePanel(guild) {
  const channel = await getTextChannelById(guild, cfg.rolePanelChannelId);
  if (!channel) throw new Error('ROLE_PANEL_CHANNEL_ID belum diisi atau channel tidak ditemukan.');
  if (!roleButtons.length && !validId(cfg.wargaRoleId)) throw new Error('ROLE_WARGA_ID atau ROLE_BUTTONS belum dikonfigurasi.');
  await channel.send({ embeds: [roleEmbed()], components: roleRows() });
  return channel;
}

async function sendWelcome(member) {
  if (!isSetupEnabled(member.guild.id, 'welcome_enabled')) return;
  const channel = await getTextChannelById(member.guild, cfg.welcomeChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle('👋 WELCOME')
    .setDescription(replaceVars(cfg.welcomeMessage, member))
    .addFields({ name: 'Member', value: `${member}`, inline: true }, { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setTimestamp();
  if (cfg.welcomeImage) embed.setImage(cfg.welcomeImage);
  await channel.send({ embeds: [embed] }).catch(() => {});
}
async function sendGoodbye(member) {
  if (!isSetupEnabled(member.guild.id, 'goodbye_enabled')) return;
  const channel = await getTextChannelById(member.guild, cfg.goodbyeChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle('👋 GOODBYE')
    .setDescription(replaceVars(cfg.goodbyeMessage, member))
    .addFields({ name: 'Member', value: member.user?.tag || member.displayName || 'Unknown', inline: true }, { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true })
    .setTimestamp();
  if (member.user) embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  if (cfg.goodbyeImage) embed.setImage(cfg.goodbyeImage);
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function syncAllOpenTicketVisibility(guild) {
  const openTickets = db.prepare(`SELECT * FROM tickets WHERE guild_id = ? AND status IN ('open', 'confirmed')`).all(guild.id);
  let updated = 0;
  for (const ticket of openTickets) {
    const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      AttachFiles: false
    }).catch(() => null);
    updated++;
  }
  if (updated) console.log(`👀 ${updated} tiket aktif sekarang dapat dilihat semua member.`);
}

async function cleanExpiredDonations() {
  const cutoff = Date.now() - donationTimeoutMs;
  for (const ticket of expiredDonations.all(cutoff)) {
    try {
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      updateTicket.run('expired', Date.now(), null, ticket.channel_id);
      if (channel) {
        await logAction(channel.guild, '⏰ Dukungan Auto-Expired', `Tiket #${String(ticket.ticket_number).padStart(4, '0')} milik <@${ticket.user_id}> tidak dikonfirmasi dalam ${cfg.donationTimeoutHours} jam.`);
        await channel.delete('Donation ticket expired').catch(() => {});
      }
    } catch (err) { console.error('Cleanup error:', err); }
  }
}

client.once('ready', async () => {
  console.log(`✅ Login sebagai ${client.user.tag}`);
  const guild = await client.guilds.fetch(cfg.guildId);
  const commands = [
    new SlashCommandBuilder()
      .setName('setup').setDescription('Setup bot')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand(sub => sub.setName('ticket').setDescription('Buat/siapkan create-ticket dan panel ticket'))
      .addSubcommand(sub => sub.setName('role').setDescription('Pasang panel pengambilan role termasuk role Warga'))
      .addSubcommand(sub => sub.setName('welcome').setDescription('Aktifkan welcome di channel yang dikonfigurasi'))
      .addSubcommand(sub => sub.setName('goodbye').setDescription('Aktifkan goodbye di channel yang dikonfigurasi'))
      .toJSON(),
    new SlashCommandBuilder().setName('panel').setDescription('Kirim panel ticket di SUPPORT').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('rolepanel').setDescription('Kirim panel pengambilan role').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles).toJSON()
  ];
  await guild.commands.set(commands);
  console.log(`✅ Commands /setup (ticket, role, welcome, goodbye), /panel dan /rolepanel terdaftar di ${guild.name}`);
  await syncAllOpenTicketVisibility(guild);
  await cleanExpiredDonations();
  setInterval(cleanExpiredDonations, 60 * 1000);
});

client.on('guildMemberAdd', member => sendWelcome(member).catch(console.error));
client.on('guildMemberRemove', member => sendGoodbye(member).catch(console.error));

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const ticket = getTicket.get(message.channel.id);
  if ((ticket?.type === 'support' || ticket?.type === 'donation') && ticket.status === 'open' && message.attachments.size > 0) {
    await message.channel.send(`📎 Bukti pembayaran/dukungan terdeteksi dari <@${message.author.id}>. Admin/Helper silakan periksa lalu tekan **Confirm Dukungan** atau **Reject Dukungan**.`).catch(() => {});
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        const sub = interaction.options.getSubcommand(false);
        if (!sub || sub === 'ticket') {
          const channel = await ensureSupportPanel(interaction.guild);
          return interaction.reply({ content: `✅ Create-ticket siap di ${channel}. Panel ticket juga sudah dipasang.`, ephemeral: true });
        }
        if (sub === 'role') {
          const channel = await ensureRolePanel(interaction.guild);
          return interaction.reply({ content: `✅ Panel role Warga sudah dipasang di ${channel}.`, ephemeral: true });
        }
        if (sub === 'welcome') {
          const channel = await getTextChannelById(interaction.guild, cfg.welcomeChannelId);
          if (!channel) return interaction.reply({ content: 'WELCOME_CHANNEL_ID belum diisi atau channel tidak ditemukan.', ephemeral: true });
          setSetupFlag(interaction.guild.id, 'welcome_enabled', true);
          await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ WELCOME AKTIF').setDescription('Sistem welcome sekarang aktif. Member baru akan mendapatkan pesan welcome di channel ini.').setTimestamp()] });
          return interaction.reply({ content: `✅ Welcome berhasil diaktifkan di ${channel}.`, ephemeral: true });
        }
        if (sub === 'goodbye') {
          const channel = await getTextChannelById(interaction.guild, cfg.goodbyeChannelId);
          if (!channel) return interaction.reply({ content: 'GOODBYE_CHANNEL_ID belum diisi atau channel tidak ditemukan.', ephemeral: true });
          setSetupFlag(interaction.guild.id, 'goodbye_enabled', true);
          await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ GOODBYE AKTIF').setDescription('Sistem goodbye sekarang aktif. Member yang keluar akan mendapatkan pesan goodbye di channel ini.').setTimestamp()] });
          return interaction.reply({ content: `✅ Goodbye berhasil diaktifkan di ${channel}.`, ephemeral: true });
        }
      }
      if (interaction.commandName === 'panel') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        const channel = await ensureSupportPanel(interaction.guild);
        return interaction.reply({ content: `Panel support dikirim ke ${channel}.`, ephemeral: true });
      }
      if (interaction.commandName === 'rolepanel') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        const channel = await ensureRolePanel(interaction.guild);
        return interaction.reply({ content: `Panel role dikirim ke ${channel}.`, ephemeral: true });
      }
    }

    if (interaction.isStringSelectMenu()) {
      const categoryKey = interaction.values[0];
      if (interaction.customId === 'support_category_select') {
        return interaction.showModal(supportModal(supportCategoryLabel(categoryKey)));
      }
      if (interaction.customId === 'report_category_select') {
        return interaction.showModal(reportModal(reportCategoryLabel(categoryKey)));
      }
      if (interaction.customId === 'form_category_select') {
        return interaction.showModal(formModal(formCategoryLabel(categoryKey)));
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'open_report') return interaction.reply({ ...reportCategoryMessage(), ephemeral: true });
      if (id === 'open_form') return interaction.reply({ ...formCategoryMessage(), ephemeral: true });
      if (id === 'open_support') return interaction.reply({ ...supportCategoryMessage(), ephemeral: true });

      if (id.startsWith('selfrole:')) {
        const roleId = id.split(':')[1];

        // Warga berasal dari ROLE_WARGA_ID, bukan ROLE_BUTTONS.
        // Sebelumnya handler hanya mencari ROLE_BUTTONS sehingga tombol
        // Warga selalu dianggap 'Role tidak ditemukan'.
        const configured = roleId === cfg.wargaRoleId
          ? { label: 'Warga', roleId, emoji: '👤' }
          : roleButtons.find(x => x.roleId === roleId);

        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!configured || !role) {
          return interaction.reply({ content: 'Role tidak ditemukan. Periksa ROLE_WARGA_ID / ROLE_BUTTONS.', ephemeral: true });
        }
        if (role.managed) {
          return interaction.reply({ content: 'Role ini dikelola Discord/integrasi dan tidak bisa digunakan.', ephemeral: true });
        }

        const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        if (!me) {
          return interaction.reply({ content: 'Bot tidak dapat membaca posisi role-nya. Pastikan bot masih ada di server.', ephemeral: true });
        }
        if (role.position >= me.roles.highest.position) {
          return interaction.reply({ content: 'Posisi role bot harus berada di atas role yang akan diberikan. Pindahkan role bot ke atas role Warga.', ephemeral: true });
        }

        if (interaction.member.roles.cache.has(roleId)) {
          await interaction.member.roles.remove(role);
          return interaction.reply({ content: `Role **${role.name}** dilepas.`, ephemeral: true });
        }

        await interaction.member.roles.add(role);
        return interaction.reply({ content: `Role **${role.name}** berhasil diberikan.`, ephemeral: true });
      }

      if (id.startsWith('feedback:')) {
        const [, channelId, ratingText] = id.split(':');
        const rating = Number(ratingText);
        if (!validId(channelId) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
          return interaction.reply({ content: 'Feedback tidak valid.', ephemeral: true });
        }
        const request = getPendingFeedback.get(channelId, interaction.user.id);
        if (!request) return interaction.reply({ content: 'Feedback ini sudah dikirim atau tidak ditemukan.', ephemeral: true });
        saveFeedbackRating.run(rating, request.id, interaction.user.id);
        const modal = new ModalBuilder().setCustomId(`feedback_modal:${request.id}`).setTitle(`Feedback ${rating}/5 ⭐`).addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('feedback_comment').setLabel('Komentar (opsional)').setPlaceholder('Tulis saran atau pengalaman kamu...').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))
        );
        return interaction.showModal(modal);
      }

      const ticket = getTicket.get(interaction.channel.id);
      if (id === 'close_ticket') {
        if (!ticket) return interaction.reply({ content: 'Ini bukan tiket.', ephemeral: true });
        if (interaction.user.id !== ticket.user_id && !isStaff(interaction.member)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        await interaction.reply({ content: 'Tiket sedang ditutup...', ephemeral: true });
        return closeTicket(interaction.channel, 'Ditutup melalui tombol', interaction.user.id);
      }

      if (['staff_confirm', 'staff_reject', 'staff_confirm_donation', 'staff_reject_donation'].includes(id)) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Hanya Admin/Helper yang dapat melakukan tindakan ini.', ephemeral: true });
        if (!ticket) return interaction.reply({ content: 'Tiket tidak ditemukan.', ephemeral: true });
        if (ticket.status !== 'open') return interaction.reply({ content: 'Tiket ini sudah diproses.', ephemeral: true });
        const donationAction = id.endsWith('_donation');
        if (donationAction !== (ticket.type === 'support' || ticket.type === 'donation')) return interaction.reply({ content: 'Tombol tidak sesuai dengan tipe tiket.', ephemeral: true });
        const confirmed = id.includes('confirm');
        updateTicket.run(confirmed ? 'confirmed' : 'rejected', Date.now(), confirmed && (ticket.type === 'support' || ticket.type === 'donation') ? Date.now() : null, ticket.channel_id);
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle(confirmed ? '✅ Dikonfirmasi' : '❌ Ditolak').setDescription(`${ticketLabel(ticket.type)} telah **${confirmed ? 'dikonfirmasi' : 'ditolak'}** oleh <@${interaction.user.id}>.`).setTimestamp()] });
        await logAction(interaction.guild, confirmed ? '✅ Tiket Confirm' : '❌ Tiket Reject', `Nomor: #${String(ticket.ticket_number).padStart(4, '0')}\nUser: <@${ticket.user_id}>\nOleh: <@${interaction.user.id}>`);
        if (!confirmed) setTimeout(() => closeTicket(interaction.channel, 'Ditolak oleh Admin/Helper', interaction.user.id), 5000);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_report' || interaction.customId.startsWith('modal_report:')) {
        const category = interaction.fields.getTextInputValue('category') || (
          interaction.customId.includes(':') ? interaction.customId.split(':').slice(1).join(':') : '📦 Lainnya'
        );
        const d = `**Kategori:** ${category}\n**Judul:** ${interaction.fields.getTextInputValue('subject')}\n**Laporan:** ${interaction.fields.getTextInputValue('description')}\n**Bukti/ID:** ${interaction.fields.getTextInputValue('evidence') || '-'}`;
        return createTicket(interaction, 'report', d);
      }
      if (interaction.customId === 'modal_form' || interaction.customId.startsWith('modal_form:')) {
        const category = interaction.fields.getTextInputValue('category') || (
          interaction.customId.includes(':') ? interaction.customId.split(':').slice(1).join(':') : '📦 Formulir Lainnya'
        );
        const d = `**Jenis formulir:** ${category}\n**Nama:** ${interaction.fields.getTextInputValue('name')}\n**Kontak:** ${interaction.fields.getTextInputValue('contact')}\n**Keperluan:** ${interaction.fields.getTextInputValue('purpose')}`;
        return createTicket(interaction, 'form', d);
      }
      if (interaction.customId === 'modal_support' || interaction.customId.startsWith('modal_support:')) {
        const category = interaction.fields.getTextInputValue('category') || (
          interaction.customId.includes(':')
            ? interaction.customId.split(':').slice(1).join(':')
            : '📦 Keperluan Lainnya'
        );
        const d =
          `**Kategori:** ${category}\n` +
          `**Nominal / Nilai:** ${interaction.fields.getTextInputValue('amount')}\n` +
          `**Metode pembayaran / bentuk kerja sama:** ${interaction.fields.getTextInputValue('method')}\n` +
          `**Catatan:** ${interaction.fields.getTextInputValue('note') || '-'}`;
        return createTicket(interaction, 'support', d);
      }
      if (interaction.customId.startsWith('feedback_modal:')) {
        const feedbackId = Number(interaction.customId.split(':')[1]);
        const request = db.prepare('SELECT * FROM ticket_feedback WHERE id = ? AND user_id = ? AND submitted_at IS NULL').get(feedbackId, interaction.user.id);
        if (!request || !request.rating) return interaction.reply({ content: 'Feedback tidak ditemukan atau sudah dikirim.', ephemeral: true });
        const comment = interaction.fields.getTextInputValue('feedback_comment') || '-';
        submitFeedback.run(comment, Date.now(), feedbackId, interaction.user.id);
        const guild = client.guilds.cache.get(request.guild_id) || await client.guilds.fetch(request.guild_id).catch(() => null);
        if (guild) await logAction(guild, '⭐ Feedback Tiket', `Tiket: #${String(request.ticket_number).padStart(4, '0')}\nUser: <@${request.user_id}>\nRating: **${request.rating}/5 ⭐**\nKomentar: ${comment}`);
        return interaction.reply({ content: `Terima kasih! Feedback **${request.rating}/5 ⭐** sudah diterima.`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Terjadi error saat memproses permintaan.', ephemeral: true }).catch(() => {});
  }
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

client.login(process.env.DISCORD_TOKEN);
