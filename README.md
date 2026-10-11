# 📸 Photobooth pour iPad et Windows

Un photobooth complet, en deux versions qui partagent le même code :

- **iPad** : une web app (PWA) qu'on installe sur l'écran d'accueil depuis Safari. Elle s'ouvre en plein écran et fonctionne **sans connexion**.
- **Windows** : une vraie application à installer, qui fonctionne avec une webcam ou avec un **appareil photo reflex ou hybride et son flash** (via digiCamControl).

## Fonctions

- **1 photo ou bande de 4** : au choix de l'invité, ou format imposé dans les réglages. Le compte à rebours démarre dès que l'invité a choisi.
- **Votre propre cadre PNG** fait dans Photoshop, ou un cadre généré (titre, texte, date, couleurs, police)
- **Envoi par mail** avec raccourcis (@gmail.com, @hotmail.fr…) et **file d'attente hors ligne** : sans réseau, la demande est gardée et part toute seule dès que la connexion revient
- Compte à rebours, flash, son, écran qui reste allumé
- **Réglages cachés** : le bouton ⚙️ en haut à droite de l'accueil est presque invisible (5 % d'opacité) et protégé par un **code PIN** (par défaut : `0000`). La galerie des photos se trouve dans les réglages, pas sur l'accueil.
- Sur Windows : **appareil photo reflex/hybride avec flash** (vraie photo pleine définition), **réglages de l'appareil** (ouverture, vitesse, ISO…) depuis l'app, **clavier virtuel** à l'écran, copie de chaque photo en JPEG dans un dossier, plein écran (mode kiosque), **gros bouton USB** (touche Entrée ou Espace)

## Utiliser votre propre cadre (PNG Photoshop)

1. Dans Photoshop, créez votre cadre et **supprimez le fond aux endroits où doivent apparaître les photos** : ces zones doivent être transparentes (le damier gris et blanc).
   - Cadre « 1 photo » : **1** zone transparente
   - Cadre « bande de 4 » : **4** zones transparentes, lues de haut en bas puis de gauche à droite (une grille 2 × 2 marche aussi)
2. **Fichier → Exporter → Exporter sous… → PNG**, en gardant la transparence.
3. Envoyez le PNG sur l'iPad (AirDrop, iCloud Drive, mail…) ou copiez-le sur le PC.
4. Dans l'app, ouvrez les réglages (⚙️), section **Cadre**, puis **Choisir un PNG**. L'app indique combien de zones elle a trouvées. **Voir un aperçu** montre le résultat.

Conseils :
- Visez au moins **1800 px** de large pour un cadre « 1 photo », et environ **1200 × 3600 px** pour une bande. Un cadre plus petit est agrandi automatiquement pour que les photos gardent la qualité de l'appareil, mais le cadre lui-même peut alors paraître flou.
- Le ratio de chaque zone transparente décide du cadrage de la caméra : une zone 4:3 ou 3:2 rend mieux qu'une zone très allongée.
- Les formes arrondies ou fantaisie marchent : la photo est placée sous le PNG, qui la découpe.
- Avec un cadre PNG, le titre, le texte et la date des réglages ne sont pas ajoutés : mettez-les directement dans votre design.
- Le cadre est enregistré dans l'app et marche hors ligne. Sans PNG, l'app crée un cadre simple.

# Version iPad

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

Dans les réglages, **Caméra** permet de passer de la caméra avant à la caméra arrière, de meilleure qualité.

# Version Windows

## 1. Installer l'application

1. Téléchargez **`Photobooth-Setup-x.y.z.exe`** :
   - dans l'onglet **Releases** du dépôt GitHub (versions publiées) ;
   - ou dans l'onglet **Actions** : ouvrez la dernière exécution réussie de « Application Windows » ; le fichier est en bas, dans **Artifacts**.
2. Lancez l'installeur. L'application n'est pas signée : si Windows affiche « Windows a protégé votre ordinateur », cliquez sur **Informations complémentaires**, puis **Exécuter quand même**.
3. Ouvrez **Photobooth** depuis le Bureau ou le menu Démarrer. Il s'ouvre en plein écran.

Pour sortir : ⚙️ → code PIN → **Quitter l'application** tout en bas des réglages (ou Alt+F4). La case **Plein écran (mode kiosque)** permet aussi de travailler dans une fenêtre normale.

## 2. Choisir la caméra

Dans les réglages, section **Prise de vue → Caméra** :

- **📷 Appareil photo (digiCamControl)**, le choix par défaut : l'application déclenche le vrai appareil photo. Le flash posé sur la griffe (ou un flash de studio avec déclencheur radio) part à chaque photo, puis l'application récupère le vrai fichier JPEG en pleine définition. C'est cette photo qui est mise en page et envoyée par mail.
- **🎥 Webcam** : l'application prend une image du flux vidéo, comme une capture d'écran, sans flash. C'est aussi ce qui se passe si l'appareil photo est branché comme une webcam (EOS Webcam Utility, mode « USB streaming », carte d'acquisition HDMI) : l'application l'indique alors par un avertissement orange.

Le bouton **📸 Photo de test** (mode appareil photo) déclenche l'appareil et affiche la photo reçue, avec son nom de fichier et sa définition (par exemple 6000 × 4000 px) : c'est la preuve que la vraie photo arrive bien.

## 3. Brancher un appareil photo avec flash (digiCamControl)

[digiCamControl](https://digicamcontrol.com/) est un logiciel gratuit pour Windows qui pilote les appareils photo en USB : **Canon et Nikon** (la plupart des modèles) et certains **Sony**. Vérifiez votre modèle dans la liste des appareils compatibles sur leur site.

**Installation (une seule fois)**

1. Installez digiCamControl depuis <https://digicamcontrol.com/>.
2. Branchez l'appareil en USB, allumez-le, puis ouvrez digiCamControl : l'appareil doit apparaître.
3. Dans digiCamControl, ouvrez **File → Settings → Webserver** et cochez :
   - **Use web server** (port **5513**),
   - **Allow interaction via webserver**.
4. Fermez puis relancez digiCamControl.
5. Dans Photobooth : ⚙️ → **Caméra** → *📷 Appareil photo*, puis **Tester l'appareil photo** et **📸 Photo de test**.

Important : l'appareil doit être branché en mode normal (PC / PTP), **pas en mode webcam ni « USB streaming »**. Fermez aussi EOS Utility, Imaging Edge ou tout autre logiciel qui utiliserait l'appareil en même temps.

Ensuite, Photobooth lance digiCamControl tout seul s'il n'est pas ouvert, et réduit sa fenêtre pendant les séances.

**Régler l'appareil depuis l'application**

Dans les réglages, sous **Réglages de l'appareil** : **ouverture (diaphragme)**, **vitesse (obturateur)**, **ISO**, **balance des blancs** et **qualité d'image**. Les listes proposent exactement les valeurs que votre appareil accepte, et chaque changement est envoyé tout de suite à l'appareil. Si une valeur ne se change pas, mettez la molette de l'appareil en **M (manuel)** : en mode automatique, l'appareil garde la main sur ces réglages. Faites ensuite une **📸 Photo de test** pour vérifier le rendu.

**Réglages conseillés sur l'appareil**

- **Format JPEG** (pas RAW seul). Une taille moyenne (M) suffit et le transfert est plus rapide.
- **Mise au point manuelle (MF)** : faites le point une fois à l'endroit où se tiendront les invités, puis passez l'objectif en MF. Ça évite les photos ratées dans la pénombre.
- **Mode manuel (M)** avec flash, par exemple 1/125 s, f/5.6, ISO 200, flash en TTL ou en manuel à 1/8. Faites quelques essais sur place.
- **Désactivez la simulation d'exposition**, sinon l'écran de visée est tout noir en mode flash :
  - Canon : *Simulation expo.* → *Désactivée* ;
  - Nikon : *Appliquer réglages à la visée écran* → *Non* ;
  - Sony : *Affichage Live View* → *Effet réglages désactivé*.
- **Arrêt automatique** de l'appareil : désactivé.
- **Alimentation secteur** (adaptateur ou fausse batterie) : le live view vide une batterie en une heure environ.
- Si le flash n'a pas le temps de se recharger entre les 4 photos d'une bande, baissez sa puissance ou augmentez la **pause entre photos** dans les réglages.
- Dans digiCamControl, gardez le transfert sur **Save to PC only**.
- Pensez à désactiver l'**effet miroir** dans les réglages si vous voulez des photos dans le vrai sens.

Pour économiser l'appareil, le live view ne tourne que pendant les séances. Il s'arrête deux minutes après la dernière photo.

## 4. Où sont les photos ?

- Chaque photo finale est copiée en JPEG dans **Images\Photobooth** (modifiable dans les réglages, section **Ordinateur**).
- Les originaux pleine définition de l'appareil photo sont dans le sous-dossier **originaux**.
- Le bouton **📂 Ouvrir le dossier** les affiche dans l'Explorateur.

## 5. Clavier virtuel

Sur un écran tactile, un clavier AZERTY s'affiche dès qu'on touche une zone de texte : l'adresse mail des invités, mais aussi tous les champs des réglages. Il a une rangée de chiffres, le **@**, les touches **.fr** et **.com**, et les accents (touche **é&?**). Le code PIN s'affiche sur un pavé numérique. Si vous utilisez un vrai clavier, vous pouvez le désactiver dans les réglages, section **Ordinateur**.

## 6. Gros bouton USB

Un gros bouton d'arcade USB qui simule la touche **Entrée** ou **Espace** suffit :

- à l'accueil, il lance la séance et le compte à rebours (si le format est imposé dans les réglages) ;
- sur le résultat, il termine et revient à l'accueil.

Avec le format au choix de l'invité, les touches **1** et **4** choisissent 1 photo ou la bande de 4.

# Envoi par mail (iPad et Windows)

L'app n'envoie pas les mails elle-même : un petit script Google sert de relais, et les mails partent depuis votre compte Gmail. La même configuration sert pour l'iPad et pour Windows.

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

## Comment marche la file d'attente

- Chaque demande d'envoi est enregistrée sur l'appareil (IndexedDB) avec la photo.
- L'app réessaie au retour du réseau, quand on la rouvre, et toutes les 20 secondes.
- Après 5 erreurs du relais (adresse refusée, quota dépassé…), la demande passe « en échec ». Vous pouvez la relancer depuis les réglages.
- Chaque envoi porte un identifiant unique : un invité ne recevra jamais le même mail deux fois.
- ⚠️ L'envoi ne se fait que quand l'app est ouverte. Après l'événement, **laissez-la ouverte** avec du réseau jusqu'à ce que la file soit vide : le compteur « ✉️ en attente » apparaît sur l'accueil.

# Conseils pour l'événement

**iPad**

- **Accès guidé** (Réglages → Accessibilité → Accès guidé) : les invités ne peuvent pas quitter l'app. Triple-clic sur le bouton pour l'activer ou le désactiver.
- **Verrouillage automatique : Jamais** (Réglages → Luminosité et affichage).
- Branchez l'iPad sur secteur et utilisez un pied ou un support.
- Pensez à **exporter les photos** depuis les réglages à la fin de l'événement.

**Windows**

- L'écran ne se met pas en veille tant que l'application est ouverte.
- Faites une séance d'essai avec l'appareil photo et le flash avant l'arrivée des invités.
- Désactivez les mises à jour automatiques de Windows et les notifications pendant l'événement.

# Développement

La version web n'a pas de build : ce sont des fichiers statiques (HTML, CSS, JS en modules).

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

Après une modification, changez `CACHE` dans `sw.js` pour que les iPads récupèrent la nouvelle version.

L'application Windows utilise Electron autour des mêmes fichiers :

```bash
npm install
npm start          # lance l'application
npm run dist       # construit l'installeur (sur Windows)
```

L'installeur est construit automatiquement par GitHub Actions (`.github/workflows/windows.yml`) à chaque mise à jour de `main`. Pour publier une version téléchargeable dans **Releases**, poussez une étiquette, par exemple `git tag v1.2.0 && git push origin v1.2.0`.

```
index.html            écrans de l'app
styles.css            styles
js/app.js             logique principale (prise de vue, galerie, réglages)
js/keyboard.js        clavier virtuel AZERTY (application Windows)
js/camera.js          sources d'image : webcam ou appareil photo (digiCamControl)
js/compose.js         mise en page des photos (cadre, bande de 4, texte)
js/frames.js          cadres PNG perso (détection des zones transparentes)
js/outbox.js          file d'envoi des mails, hors ligne
js/db.js              stockage IndexedDB
js/settings.js        réglages par défaut
sw.js                 cache hors ligne
apps-script/Code.gs   relais d'envoi des mails (Google Apps Script)
desktop/main.js       application Windows (fenêtre, dossiers, plein écran)
desktop/camera.js     pilotage de digiCamControl (live view, déclenchement, fichiers)
desktop/preload.js    pont entre la page et l'application Windows
package.json          dépendances et configuration de l'installeur
```
