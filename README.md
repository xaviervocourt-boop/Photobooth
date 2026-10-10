# 📸 Photobooth pour iPad

Une web app (PWA) qui transforme un iPad en photobooth. On l'installe sur l'écran d'accueil depuis Safari, elle s'ouvre en plein écran et fonctionne **sans connexion**.

## Fonctions

- **1 photo ou bande de 4** : au choix de l'invité, ou format imposé dans les réglages
- **Filtres** avec aperçu en direct : Normal, Noir & blanc, Sépia, Vintage, Chaud, Froid, Pop, Ciné
- **Cadre personnalisé** : titre, texte, date, couleurs et police
- **Galerie** de toutes les photos de l'événement, avec export vers Photos ou AirDrop
- **Envoi par mail** avec **file d'attente hors ligne** : sans réseau, la demande est gardée sur l'iPad et part toute seule dès que la connexion revient
- Compte à rebours, flash, son, écran qui reste allumé
- Réglages protégés par un **code PIN** (par défaut : `0000`)

## 1. Mettre l'app en ligne

L'iPad a besoin d'une adresse **https** pour accéder à la caméra. Le plus simple est GitHub Pages :

1. Sur GitHub, ouvrez le dépôt, puis **Settings → Pages**.
2. Dans **Source**, choisissez **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`. Cliquez sur **Save**.
3. Après une minute, l'app est disponible à l'adresse `https://<votre-pseudo>.github.io/Photobooth/`.

> GitHub Pages est gratuit pour un dépôt public. Pour un dépôt privé, il faut un compte GitHub Pro. Sinon, Netlify ou Cloudflare Pages font la même chose gratuitement : il suffit de glisser-déposer le dossier.

## 2. Installer sur l'iPad

1. Ouvrez l'adresse dans **Safari**.
2. Touchez **Partager** (le carré avec la flèche), puis **Sur l'écran d'accueil**.
3. Lancez **Photobooth** depuis l'écran d'accueil et autorisez la caméra.

Ouvrez l'app au moins une fois avec du réseau. Ensuite, elle fonctionne hors ligne.

## 3. Configurer l'envoi par mail (gratuit, via votre Gmail)

Une web app ne peut pas envoyer de mails toute seule. Un petit script Google sert donc de relais : les mails partent depuis votre compte Gmail.

1. Allez sur <https://script.google.com> et créez un **Nouveau projet**.
2. Remplacez le contenu par celui du fichier [`apps-script/Code.gs`](apps-script/Code.gs).
3. En haut du fichier, remplacez `change-moi` par un code secret de votre choix (par exemple `mariage-lea-tom-2026`).
4. Sélectionnez la fonction `autoriser` et cliquez sur **Exécuter**. Google demande d'autoriser l'envoi de mails : acceptez. Si un écran « Application non validée » apparaît, cliquez sur **Paramètres avancés**, puis **Accéder au projet**.
5. Cliquez sur **Déployer → Nouveau déploiement** et choisissez le type **Application Web** :
   - **Exécuter en tant que** : *Moi*
   - **Qui a accès** : *Tout le monde*
6. Cliquez sur **Déployer** et copiez l'**URL de l'application Web** (elle finit par `/exec`).
7. Dans l'app, ouvrez les réglages (⚙️ puis le code PIN). Collez l'URL et le code secret, puis touchez **Tester la connexion au relais**.

> Si vous modifiez le script plus tard, faites **Déployer → Gérer les déploiements → Modifier → Nouvelle version** pour garder la même URL.

**Limites de Gmail** : environ 100 mails par jour avec un compte Gmail gratuit, et environ 1 500 avec Google Workspace. Le quota restant s'affiche quand vous testez la connexion.

### Comment marche la file d'attente

- Chaque demande d'envoi est enregistrée sur l'iPad (IndexedDB) avec la photo.
- L'app réessaie au retour du réseau, quand on la rouvre, et toutes les 20 secondes.
- Après 5 erreurs du relais (adresse refusée, quota dépassé…), la demande passe « en échec ». Vous pouvez la relancer depuis les réglages.
- Chaque envoi porte un identifiant unique : un invité ne recevra jamais le même mail deux fois.
- ⚠️ Safari ne permet pas d'envoyer en arrière-plan. Après l'événement, **laissez l'app ouverte** avec du réseau jusqu'à ce que la file soit vide : le compteur « ✉️ en attente » apparaît sur l'accueil.

## Conseils pour l'événement

- **Accès guidé** (Réglages → Accessibilité → Accès guidé) : les invités ne peuvent pas quitter l'app. Triple-clic sur le bouton pour l'activer ou le désactiver.
- **Verrouillage automatique : Jamais** (Réglages → Luminosité et affichage).
- Branchez l'iPad sur secteur et utilisez un pied ou un support.
- Pensez à **exporter les photos** depuis les réglages à la fin de l'événement.

## Développement

Pas de build : ce sont des fichiers statiques (HTML, CSS, JS en modules).

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

Après une modification, changez `CACHE` dans `sw.js` pour que les iPads récupèrent la nouvelle version.

```
index.html            écrans de l'app
styles.css            styles
js/app.js             logique principale (caméra, prise de vue, galerie, réglages)
js/compose.js         mise en page des photos (cadre, bande de 4, texte)
js/filters.js         filtres (aperçu CSS + rendu pixel identique)
js/outbox.js          file d'envoi des mails, hors ligne
js/db.js              stockage IndexedDB
js/settings.js        réglages par défaut
sw.js                 cache hors ligne
apps-script/Code.gs   relais d'envoi des mails (Google Apps Script)
```
