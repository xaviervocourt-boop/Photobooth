/**
 * Relais d'envoi de mails pour le Photobooth.
 * Le mail part depuis le compte Gmail qui déploie ce script.
 * Installation : voir le README du projet.
 */

// ⚠️ Changez ce code et recopiez-le dans les réglages de l'app.
const SECRET = 'change-moi';
const SENDER_NAME = 'Photobooth';

function doGet(e) {
  if ((e.parameter.secret || '') !== SECRET) return json({ ok: false, error: 'Code secret invalide' });
  return json({ ok: true, status: 'Relais photobooth actif', quotaRestant: MailApp.getRemainingDailyQuota() });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return json({ ok: false, error: 'Code secret invalide' });

    // Évite les doublons si l'app renvoie une demande dont la réponse s'est perdue.
    const props = PropertiesService.getScriptProperties();
    const key = 'sent_' + data.id;
    if (data.id && props.getProperty(key)) return json({ ok: true, duplicate: true });

    const to = String(data.to || '').split(',').map(function (s) { return s.trim(); }).filter(String);
    const valid = to.length > 0 && to.every(function (a) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a); });
    if (!valid) return json({ ok: false, error: 'Adresse invalide', fatal: true });

    const image = Utilities.newBlob(
      Utilities.base64Decode(data.image),
      data.mimeType || 'image/jpeg',
      data.filename || 'photobooth.jpg'
    );
    const body = String(data.body || '');
    const html =
      '<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;color:#222">' +
      '<p>' + escapeHtml(body).replace(/\n/g, '<br>') + '</p>' +
      '<p><img src="cid:photo" style="max-width:100%;border-radius:6px"></p>' +
      '</div>';

    MailApp.sendEmail({
      to: to.join(','),
      subject: data.subject || 'Votre photo',
      body: body,
      htmlBody: html,
      name: SENDER_NAME,
      inlineImages: { photo: image },
      attachments: [image],
    });

    if (data.id) props.setProperty(key, String(Date.now()));
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// À lancer une fois à la main dans l'éditeur pour autoriser l'envoi de mails.
function autoriser() {
  Logger.log('Quota restant aujourd\'hui : ' + MailApp.getRemainingDailyQuota());
}
