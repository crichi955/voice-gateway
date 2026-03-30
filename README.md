# Voice Gateway (Twilio + ElevenLabs + OpenAI + n8n)

Voice Gateway Node.js pour appels entrants Twilio.

Le role de ce service:
- transporter l'audio Twilio via WebSocket,
- transcrire la question patient (OpenAI STT),
- appeler n8n (cerveau FAQ/scoring/fallback),
- jouer la reponse vocale (ElevenLabs),
- envoyer WhatsApp en fallback/degrade.

## Prerequis

- Node.js 20+ (24 recommande)
- Un compte Twilio (Voice + WhatsApp)
- Un compte ElevenLabs
- Un endpoint n8n accessible publiquement

## Variables d'environnement

Copier `.env.example` vers `.env`, puis renseigner les valeurs.

Variables importantes:
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `WHATSAPP_FROM`
- `WHATSAPP_FALLBACK_URL`
- `N8N_BRAIN_URL`
- `STT_MODEL`, `STT_LANGUAGE`
- `KILL_SWITCH`

## Lancement local

```bash
npm install
npm run check
npm start
```

Serveur local par defaut: `http://localhost:3000`

Healthcheck: `GET /health`

Webhook Twilio: `POST /twilio/voice`

WebSocket media stream: `/twilio`

## Contrat JSON attendu de n8n

`server.js` attend:

```json
{ "action": "answer" | "fallback" | "urgence", "text": "string", "whatsappUrl": "string?" }
```

## Deploiement Render

1. **Push du projet sur GitHub**
   - Le repo doit contenir au minimum: `server.js`, `package.json`, `package-lock.json`, `.env.example`, `README.md`.

2. **Creer un Web Service sur Render**
   - New -> Web Service -> connecter le repo.
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`

3. **Configurer les variables d'environnement Render**
   - Ajouter toutes les variables de `.env.example` (sauf eventuellement `PORT`, gere par Render).
   - Mettre `KILL_SWITCH=false` en production sauf besoin d'arret rapide.

4. **Verifier le deploy**
   - Ouvrir `https://voice-gateway.onrender.com/health`
   - Doit repondre `ok`.

5. **Configurer Twilio Voice webhook**
   - Dans Twilio (numero entrant), configurer:
     - **A call comes in** -> Webhook (HTTP POST)
     - URL: `https://voice-gateway.onrender.com/twilio/voice`

6. **Tester un appel entrant**
   - Attendu:
     - message d'accueil vocal,
     - STT de la question,
     - appel n8n,
     - lecture reponse/fallback/urgence selon `action`,
     - envoi WhatsApp en fallback/degrade.

## Notes de production

- Render force HTTPS sur l'URL publique, donc Twilio utilisera `wss://.../twilio`.
- Si `N8N_BRAIN_URL` depasse 5 secondes de reponse, le mode degrade se declenche automatiquement.
- `KILL_SWITCH=true` active une coupure globale du pipeline 10 secondes apres le demarrage du process.
