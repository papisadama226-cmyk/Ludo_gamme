// api/roll-dice.js
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'missing_token' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { gameId } = req.body;
    if (!gameId) return res.status(400).json({ error: 'missing_gameId' });

    const gameRef = db.collection('games').doc(gameId);

    const result = await db.runTransaction(async (t) => {
      const gameSnap = await t.get(gameRef);
      if (!gameSnap.exists) throw new Error('game_not_found');
      const game = gameSnap.data();

      if (game.status !== 'en_cours') throw new Error('game_not_active');
      if (game.currentTurnUid !== uid) throw new Error('not_your_turn');
      if (game.awaitingMove) throw new Error('move_pending');

      const value = Math.floor(Math.random() * 6) + 1;

      const rollRef = gameRef.collection('rolls').doc();
      t.set(rollRef, { uid, value, createdAt: admin.firestore.FieldValue.serverTimestamp() });

      t.update(gameRef, { lastRoll: value, awaitingMove: true });

      return { value };
    });

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('Erreur roll-dice:', err.message);
    const knownErrors = ['not_your_turn', 'game_not_active', 'game_not_found', 'move_pending'];
    const status = knownErrors.includes(err.message) ? 400 : 500;
    return res.status(status).json({ error: err.message || 'internal_error' });
  }
}
