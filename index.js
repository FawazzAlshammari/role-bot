require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require('discord.js');

const COMMAND_NAME = 'رولي';

const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || null;

const PANEL_TTL_MS  = parseInt(process.env.PANEL_TTL_MS  || '60000', 10);
const PROMPT_TTL_MS = parseInt(process.env.PROMPT_TTL_MS || '7000', 10);
const RESULT_TTL_MS = parseInt(process.env.RESULT_TTL_MS || '7000', 10);

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

// ================== Pending (الكتابة في الشات) ==================
// key: guildId:userId => { action, channelId, roleId, promptMsgId, expiresAt }
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

// ================== /رولي ==================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== COMMAND_NAME) return;

  if (CONTROL_CHANNEL_ID && interaction.channelId !== CONTROL_CHANNEL_ID) {
    return interaction.reply({ content: '❌ استخدم الأمر في روم الكنترول فقط.', ephemeral: true });
  }

  // نكتفي برسالة مؤقتة (Ephemeral) هنا، لأنها ما تهم
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({ content: '❌ تحتاج صلاحية Manage Roles.', ephemeral: true });
  }
  const me = interaction.guild.members.me;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.reply({ content: '❌ البوت يحتاج Manage Roles.', ephemeral: true });
  }

  await interaction.reply({ content: '✅ تم إرسال اللوحة في روم الكنترول.', ephemeral: true });
  await sendPanel(interaction.channel);
});

// ================== أزرار اللوحة (بدون Ephemeral نهائياً) ==================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.guild || !interaction.channel) return;

  if (CONTROL_CHANNEL_ID && interaction.channelId !== CONTROL_CHANNEL_ID) {
    // ما نرسل Ephemeral حتى هنا — نسوي deferUpdate وخلاص
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const { guild, user, channel } = interaction;
  const delOk = canBotDeleteMessages(channel);

  // مهم: هذا يمنع رسائل "Only you can see this"
  await interaction.deferUpdate().catch(() => {});

  // صلاحيات
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) {
    const m = await say(channel, `❌ ${user} تحتاج صلاحية Manage Roles.`);
    if (delOk) deleteLater(m, RESULT_TTL_MS);
    return;
  }
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

  // باقي الأزرار تحتاج رول
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
      promptMsgId: promptMsg?.id || null,
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
      promptMsgId: promptMsg?.id || null,
      expiresAt: Date.now() + 30_000
    });
    return;
  }

  // تغيير الصورة
  if (interaction.customId === 'btn_icon') {
    const promptMsg = await say(channel, `🖼️ ${user} ارسل إيموجي 😀🔥 أو رابط صورة مباشر خلال 45 ثانية (أو cancel).`);
    if (delOk) deleteLater(promptMsg, PROMPT_TTL_MS);

    setPending(guild.id, user.id, {
      action: 'icon',
      channelId: channel.id,
      roleId: role.id,
      promptMsgId: promptMsg?.id || null,
      expiresAt: Date.now() + 45_000
    });
    return;
  }

  // إضافة/إزالة لشخص
  if (interaction.customId === 'btn_toggle') {
    const promptMsg = await say(channel, `👤 ${user} اكتب منشن/ID للشخص خلال 30 ثانية (أو cancel).`);
    if (delOk) deleteLater(promptMsg, PROMPT_TTL_MS);

    setPending(guild.id, user.id, {
      action: 'toggle',
      channelId: channel.id,
      roleId: role.id,
      promptMsgId: promptMsg?.id || null,
      expiresAt: Date.now() + 30_000
    });
    return;
  }
});

// ================== "رولي" بالشات + تنفيذ pending ==================
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    if (CONTROL_CHANNEL_ID && message.channel.id !== CONTROL_CHANNEL_ID) return;

    const delOk = canBotDeleteMessages(message.channel);
    const txt = (message.content || '').trim();

    // فتح اللوحة بكلمة "رولي"
    if (txt === 'رولي') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        const m = await say(message.channel, `❌ ${message.author} تحتاج Manage Roles.`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }
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
      try {
        await role.setIcon(content);
        clearPending(guild.id, message.author.id);

        const m = await say(message.channel, `🖼️ تم تغيير أيقونة الرول إلى: ${content}`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      } catch {
        clearPending(guild.id, message.author.id);
        const m = await say(message.channel, `❌ ما قدرت أغير الأيقونة. جرّب إيموجي 😀 أو رابط PNG/JPG مباشر (قد يتطلب Boost).`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }
    }

    if (state.action === 'toggle') {
      const mentioned = message.mentions.users.first();
      const targetId = mentioned?.id || parseUserId(content);

      if (!targetId) {
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
        const m = await say(message.channel, `✅ تم إعطاء الرول لـ ${target}`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      } else {
        await target.roles.remove(role.id).catch(() => {});
        const m = await say(message.channel, `❌ تم إزالة الرول من ${target}`);
        if (delOk) deleteLater(m, RESULT_TTL_MS);
        return;
      }
    }


  } catch {
    // تجاهل
  }
});

client.login(process.env.TOKEN);
