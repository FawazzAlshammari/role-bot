require('dotenv').config();
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  AttachmentBuilder
} = require('discord.js');

const COMMAND_NAME = 'رولي';

// يسمح لك تستخدم متغير واحد أو أكثر
// CONTROL_CHANNEL_ID=123
// أو CONTROL_CHANNEL_IDS=123,456
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || null;
const CONTROL_CHANNEL_IDS = (process.env.CONTROL_CHANNEL_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isControlChannel(channelId) {
  if (CONTROL_CHANNEL_IDS.length) return CONTROL_CHANNEL_IDS.includes(channelId);
  if (CONTROL_CHANNEL_ID) return channelId === CONTROL_CHANNEL_ID;
  return true; // لو ما حددت شي، يشتغل بكل الرومات (مو مستحسن)
}

const PANEL_TTL_MS  = parseInt(process.env.PANEL_TTL_MS  || '120000', 10); // 2 دقيقة
const PROMPT_TTL_MS = parseInt(process.env.PROMPT_TTL_MS || '45000', 10);  // 45 ثانية
const RESULT_TTL_MS = parseInt(process.env.RESULT_TTL_MS || '7000', 10);   // 7 ثواني

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ================== تخزين رول واحد لكل شخص ==================
const DATA_FILE = path.join(__dirname, 'roles.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const userRoles = loadData(); // { [guildId]: { [userId]: roleId } }

function getRoleId(guildId, userId) {
  return userRoles[guildId]?.[userId] || null;
}
function setRoleId(guildId, userId, roleId) {
  userRoles[guildId] = userRoles[guildId] || {};
  userRoles[guildId][userId] = roleId;
  saveData(userRoles);
}
function clearRoleId(guildId, userId) {
  if (!userRoles[guildId]) return;
  delete userRoles[guildId][userId];
  saveData(userRoles);
}

// ================== Helpers ==================
function parseUserId(input) {
  const s = (input || '').trim();
  const m = s.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  if (/^\d{15,25}$/.test(s)) return s;
  return null;
}

function normalizeHex(input) {
  const v = (input || '').trim();
  if (!v) return null;
  const ok = /^#?[0-9A-Fa-f]{6}$/.test(v);
  if (!ok) return null;
  return v.startsWith('#') ? v : `#${v}`;
}

async function say(channel, text) {
  try { return await channel.send(text); } catch { return null; }
}

function deleteLater(msg, ms) {
  try {
    if (!msg) return;
    setTimeout(() => msg.delete().catch(() => {}), ms);
  } catch {}
}

function canBotDeleteMessages(channel) {
  try {
    return channel
      ?.permissionsFor(channel.guild.members.me)
      ?.has(PermissionsBitField.Flags.ManageMessages);
  } catch {
    return false;
  }
}

function botAboveRole(guild, role) {
  const me = guild.members.me;
  return role.position < me.roles.highest.position;
}

function requireUserRole(guild, userId) {
  const roleId = getRoleId(guild.id, userId);
  if (!roleId) return { ok: false, msg: '❌ ما عندك رول. اضغط **إنشاء رول** أولاً.' };

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    clearRoleId(guild.id, userId);
    return { ok: false, msg: '❌ رولك القديم ما عاد موجود. اضغط **إنشاء رول** من جديد.' };
  }
  return { ok: true, role };
}

// تحويل إيموجي يونيكود → رابط صورة Twemoji PNG
function unicodeEmojiToTwemojiPng(emoji) {
  const cps = [];
  for (const ch of [...emoji.trim()]) cps.push(ch.codePointAt(0).toString(16));
  const code = cps.join('-');
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`;
}

// يحاول فهم الإدخال: مرفق/رابط/إيموجي مخصص/إيموجي عادي
function extractIconSource(message, rawText) {
  // 1) Attachment (صورة مرفقة)
  if (message?.attachments?.size) {
    const a = message.attachments.first();
    return { ok: true, url: a.url };
  }

  const text = (rawText || '').trim();
  if (!text) return { ok: false, reason: 'empty' };

  // 2) رابط مباشر
  if (/^https?:\/\//i.test(text)) {
    return { ok: true, url: text };
  }

  // 3) إيموجي مخصص <:name:id> أو <a:name:id>
  const m = text.match(/<a?:\w+:(\d+)>/);
  if (m) {
    const id = m[1];
    const animated = text.startsWith('<a:');
    const ext = animated ? 'gif' : 'png';
    return { ok: true, url: `https://cdn.discordapp.com/emojis/${id}.${ext}?size=96&quality=lossless` };
  }

  // 4) إيموجي عادي (Unicode)
  // نعتبر أول رمز فقط (عشان لو كتب كلام كثير)
  const first = [...text][0];
  if (first) {
    return { ok: true, url: unicodeEmojiToTwemojiPng(first) };
  }

  return { ok: false, reason: 'unknown' };
}

// ================== Pending (الكتابة في الشات) ==================
// key: guildId:userId => { action, channelId, roleId, expiresAt }
const pending = new Map();

function setPending(guildId, userId, payload) {
  pending.set(`${guildId}:${userId}`, payload);
}
function getPending(guildId, userId) {
  return pending.get(`${guildId}:${userId}`) || null;
}
function clearPending(guildId, userId) {
  pending.delete(`${guildId}:${userId}`);
}

// ================== UI ==================
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('لوحة رولك الشخصي')
    .setDescription(
      'اختر زر، وبعدها اكتب المطلوب في شات الروم.\n' +
      '🛑 تقدر تكتب **cancel** لإلغاء أي عملية.\n\n'
    )
    .setColor(0x6d28d9);
}

function buildPanelRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_create').setLabel('إنشاء رول').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('btn_rename').setLabel('تغيير الاسم').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_color').setLabel('تغيير اللون').setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_icon').setLabel('تغيير الصورة').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_toggle').setLabel('إضافة/إزالة لشخص').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_delete').setLabel('حذف الرول').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

async function sendPanel(channel) {
  const delOk = canBotDeleteMessages(channel);
  const panelMsg = await channel.send({
    embeds: [buildPanelEmbed()],
    components: buildPanelRows()
  });
  if (delOk) deleteLater(panelMsg, PANEL_TTL_MS);
  return panelMsg;
}

// ================== Ready ==================
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// ================== Slash Command /رولي (اختياري) ==================
// ملاحظة: ما نطلب Manage Roles من المستخدم — فقط البوت لازم يكون عنده.
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== COMMAND_NAME) return;

  if (!isControlChannel(interaction.channelId)) {
    return interaction.reply({ content: '❌ استخدم الأمر في روم الكنترول فقط.', ephemeral: true });
  }

  const me = interaction.guild.members.me;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({ content: '❌ البوت يحتاج صلاحية Manage Roles.', ephemeral: true });
  }

  await interaction.reply({ content: '✅ تم إرسال اللوحة في روم الكنترول.', ephemeral: true });
  await sendPanel(interaction.channel);
});

// ================== أزرار اللوحة ==================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.guild || !interaction.channel) return;

  if (!isControlChannel(interaction.channelId)) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const { guild, user, channel } = interaction;
  const delOk = canBotDeleteMessages(channel);

  // يمنع رسائل "Only you can see this"
  await interaction.deferUpdate().catch(() => {});

  // تأكد البوت عنده Manage Roles فقط
  const me = guild.members.me;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    const m = await say(channel, `❌ ما عندي صلاحية Manage Roles.`);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }

  // إلغاء
  if (interaction.customId === 'btn_cancel') {
    clearPending(guild.id, user.id);
    const m = await say(channel, `✅ ${user} تم الإلغاء.`);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }

  // حذف رول
  if (interaction.customId === 'btn_delete') {
    clearPending(guild.id, user.id);

    const roleId = getRoleId(guild.id, user.id);
    if (!roleId) {
      const m = await say(channel, `❌ ${user} ما عندك رول أصلاً.`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    const role = guild.roles.cache.get(roleId);
    if (!role) {
      clearRoleId(guild.id, user.id);
      const m = await say(channel, `🗑️ ${user} تم تنظيف بيانات رولك (كان محذوف).`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    if (!botAboveRole(guild, role)) {
      const m = await say(channel, `❌ ارفع رول البوت فوق رولك عشان يقدر يحذفه.`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member?.roles.cache.has(role.id)) {
      await member.roles.remove(role.id).catch(() => {});
    }

    await role.delete(`Delete personal role for ${user.tag}`).catch(() => {});
    clearRoleId(guild.id, user.id);

    const m = await say(channel, `🗑️ ${user} حذف رولَه الشخصي.`);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }

  // إنشاء رول (ممنوع إذا عنده رول)
  if (interaction.customId === 'btn_create') {
    const oldRoleId = getRoleId(guild.id, user.id);

    if (oldRoleId) {
      const existingRole = guild.roles.cache.get(oldRoleId);
      if (existingRole) {
        const m = await say(channel, `❌ ${user} عندك رول بالفعل: <@&${existingRole.id}> (احذف القديم أولاً).`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      } else {
        clearRoleId(guild.id, user.id);
      }
    }

    const newRole = await guild.roles.create({
      name: `رول ${user.username}`,
      reason: `Personal role created for ${user.tag}`
    });

    setRoleId(guild.id, user.id, newRole.id);

    // لازم رول البوت يكون فوق الرول عشان يقدر يعدله لاحقاً
    if (!botAboveRole(guild, newRole)) {
      const m = await say(channel, `✅ ${user} تم إنشاء رول: <@&${newRole.id}> (ارفع رول البوت فوقه للتعديل)`);

      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) await member.roles.add(newRole.id).catch(() => {});

    const m = await say(channel, `✅ ${user} تم إنشاء رولك وانضاف لك: <@&${newRole.id}>`);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }

  // باقي الأزرار تحتاج رول (وتعديل رول الشخص نفسه فقط)
  const check = requireUserRole(guild, user.id);
  if (!check.ok) {
    const m = await say(channel, check.msg);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }
  const role = check.role;

  if (!botAboveRole(guild, role)) {
    const m = await say(channel, `❌ ارفع رول البوت فوق رولك في Roles.`);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }

  // تغيير الاسم
  if (interaction.customId === 'btn_rename') {
    const promptMsg = await say(channel, `✏️ ${user} اكتب اسم الرول الجديد خلال 30 ثانية (أو cancel).`);
    if (delOk) deleteLater(promptMsg, PROMPT_TTL_MS);

    setPending(guild.id, user.id, {
      action: 'rename',
      channelId: channel.id,
      roleId: role.id,
      expiresAt: Date.now() + 30_000
    });
    return;
  }

  // تغيير اللون
  if (interaction.customId === 'btn_color') {
    const promptMsg = await say(channel, `🎨 ${user} اكتب لون Hex مثل #ff00aa خلال 30 ثانية (أو cancel).`);
    if (delOk) deleteLater(promptMsg, PROMPT_TTL_MS);

    setPending(guild.id, user.id, {
      action: 'color',
      channelId: channel.id,
      roleId: role.id,
      expiresAt: Date.now() + 30_000
    });
    return;
  }

  // تغيير الصورة
  if (interaction.customId === 'btn_icon') {
    const promptMsg = await say(channel, `🖼️ ${user} ارسل **إيموجي** أو **صورة** أو **رابط صورة** خلال 45 ثانية (أو cancel).`);
    if (delOk) deleteLater(promptMsg, PROMPT_TTL_MS);

    setPending(guild.id, user.id, {
      action: 'icon',
      channelId: channel.id,
      roleId: role.id,
      expiresAt: Date.now() + 45_000
    });
    return;
  }

  // إضافة/إزالة لشخص (يعطي/يشيل رول "المستخدم" لشخص آخر)
  // ملاحظة: هذا ما يعطي صلاحيات تعديل أي رول ثاني — فقط روله هو.
  if (interaction.customId === 'btn_toggle') {
    const promptMsg = await say(channel, `👤 ${user} اكتب منشن/ID للشخص خلال 30 ثانية (أو cancel).`);
    if (delOk) deleteLater(promptMsg, PROMPT_TTL_MS);

    setPending(guild.id, user.id, {
      action: 'toggle',
      channelId: channel.id,
      roleId: role.id,
      expiresAt: Date.now() + 30_000
    });
    return;
  }
});

// ================== "رولي" بالشات + تنفيذ pending ==================
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    if (!isControlChannel(message.channel.id)) return;

    const delOk = canBotDeleteMessages(message.channel);
    const txt = (message.content || '').trim();

    // فتح اللوحة بكلمة "رولي" — بدون أي صلاحية للأعضاء
    if (txt === 'رولي') {
      const me = message.guild.members.me;
      if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        const m = await say(message.channel, `❌ ما عندي Manage Roles.`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }

      if (delOk) message.delete().catch(() => {});
      await sendPanel(message.channel);
      return;
    }

    // تنفيذ العمليات المعلقة
    const state = getPending(message.guild.id, message.author.id);
    if (!state) return;

    if (message.channel.id !== state.channelId) return;

    if (Date.now() > state.expiresAt) {
      clearPending(message.guild.id, message.author.id);
      if (delOk) message.delete().catch(() => {});
      const m = await say(message.channel, `⌛ انتهى الوقت. اضغط الزر مرة ثانية.`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    const content = (message.content || '').trim();

    if (content.toLowerCase() === 'cancel') {
      clearPending(message.guild.id, message.author.id);
      if (delOk) message.delete().catch(() => {});
      const m = await say(message.channel, `✅ تم الإلغاء.`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    const guild = message.guild;
    const role = guild.roles.cache.get(state.roleId);

    if (!role) {
      clearPending(guild.id, message.author.id);
      clearRoleId(guild.id, message.author.id);
      if (delOk) message.delete().catch(() => {});
      const m = await say(message.channel, `❌ رولك غير موجود. سوِّ "رولي" ثم إنشاء رول من جديد.`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    if (!botAboveRole(guild, role)) {
      clearPending(guild.id, message.author.id);
      if (delOk) message.delete().catch(() => {});
      const m = await say(message.channel, `❌ ارفع رول البوت فوق رول <@&${role.id}>.`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    // احذف رسالة المستخدم فوراً
    if (delOk) await message.delete().catch(() => {});

    // تنفيذ حسب النوع
    if (state.action === 'rename') {
      const newName = content.slice(0, 50);
      await role.setName(newName).catch(() => {});
      clearPending(guild.id, message.author.id);

      const m = await say(message.channel, `✏️ تم تغيير اسم الرول إلى **${newName}**`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    if (state.action === 'color') {
      const hex = normalizeHex(content);
      if (!hex) {
        const m = await say(message.channel, `❌ اكتب Hex صحيح مثل #ff00aa`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }

      await role.setColor(hex).catch(() => {});
      clearPending(guild.id, message.author.id);

      const m = await say(message.channel, `🎨 تم تغيير لون الرول إلى **${hex}**`);
      if (delOk) deleteLater(m, RESULT_TTL_MS);
      return;
    }

    if (state.action === 'icon') {
      const icon = extractIconSource(message, content);
      clearPending(guild.id, message.author.id);

      if (!icon.ok) {
        const m = await say(message.channel, `❌ أرسل إيموجي أو صورة أو رابط صورة.`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }

      try {
        await role.setIcon(icon.url);
        const m = await say(message.channel, `🖼️ تم تغيير أيقونة الرول.`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      } catch {
        const m = await say(message.channel, `❌ ما قدرت أغير الأيقونة. (تأكد السيرفر Boost 2 + البوت عنده Manage Roles + Attach Files ليس مطلوب هنا)`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }
    }

    if (state.action === 'toggle') {
      const mentioned = message.mentions.users.first();
      const targetId = mentioned?.id || parseUserId(content);

      if (!targetId) {
        clearPending(guild.id, message.author.id);
        const m = await say(message.channel, `❌ اكتب منشن صحيح أو ID صحيح.`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }

      const target = await guild.members.fetch(targetId).catch(() => null);
      clearPending(guild.id, message.author.id);

      if (!target) {
        const m = await say(message.channel, `❌ ما لقيت العضو.`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }

      const has = target.roles.cache.has(role.id);
      if (!has) {
        await target.roles.add(role.id).catch(() => {});
        const m = await say(message.channel, `✅ تم إعطاء رولك لـ ${target}`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      } else {
        await target.roles.remove(role.id).catch(() => {});
        const m = await say(message.channel, `❌ تم إزالة رولك من ${target}`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }
    }
  } catch {
    // تجاهل
  }
});


// ==================== Welcome (ترحيب) ====================
// حط ملف welcome.png داخل نفس مجلد index.js وارفعه للـ GitHub
// وحط متغير بيئة: WELCOME_CHANNEL_ID = ايدي روم الترحيب
client.on('guildMemberAdd', async (member) => {
  try {
    const chId = process.env.WELCOME_CHANNEL_ID;
    if (!chId) return;
    const channel = member.guild.channels.cache.get(chId);
    if (!channel || !channel.isTextBased()) return;

    const canvas = createCanvas(735, 245);
    const ctx = canvas.getContext('2d');

    // Background template
    const bg = await loadImage(path.join(__dirname, 'welcome.png'));
    ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);

    // Member avatar (left circle)
    const avatarURL = member.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
    const avatar = await loadImage(avatarURL);

    const cx = 250; // center X
    const cy = 110;  // center Y
    const r = 58;   // radius

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'welcome.png' });

    await channel.send({ content: `ارحب ${member} ✨`, files: [attachment] });
  } catch (e) {
    console.log('Welcome error:', e);
  }
});

client.login(process.env.TOKEN);
