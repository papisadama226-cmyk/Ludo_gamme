// api/move-token.js
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
const FINISH = 57;

// Récompenses (cosmétiques/progression uniquement, jamais un avantage en partie)
const XP_WIN = 50;
const XP_LOSE = 10;
const PIECES_WIN = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'missing_token' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const { gameId, tokenIndex } = req.body;
    if (!gameId || tokenIndex === undefined) return res.status(400).json({ error: 'missing_params' });

    const gameRef = db.collection('games').doc(gameId);

    const result = await db.runTransaction(async (t) => {
      const gameSnap = await t.get(gameRef);
      if (!gameSnap.exists) throw new Error('game_not_found');
      const game = gameSnap.data();

      if (game.currentTurnUid !== uid) throw new Error('not_your_turn');
      if (!game.awaitingMove) throw new Error('no_pending_roll');

      const value = game.lastRoll;
      const tokens = game.tokens || {};
      const myTokens = tokens[uid] || [-1, -1, -1, -1];
      const current = myTokens[tokenIndex];

      if (current === undefined) throw new Error('invalid_token');
      if (current === FINISH) throw new Error('token_already_finished');

      let next;
      if (current === -1) {
        if (value !== 6) throw new Error('need_six_to_exit');
        next = 0;
      } else {
        next = current + value;
        if (next > FINISH) throw new Error('overshoot');
      }

      myTokens[tokenIndex] = next;
      tokens[uid] = myTokens;

      const players = game.players || [];
      const idx = players.indexOf(uid);
      const nextTurnUid = value === 6 ? uid : players[(idx + 1) % players.length];

      const hasWon = myTokens.every((p) => p === FINISH);

      const update = { tokens, awaitingMove: false, currentTurnUid: nextTurnUid };
      if (hasWon) {
        update.status = 'terminee';
        update.winnerUid = uid;
      }
      t.update(gameRef, update);

      return { newPosition: next, nextTurnUid, hasWon, players: game.players };
    });

    // Récompenses + stats après victoire (transaction séparée par joueur)
    if (result.hasWon) {
      await Promise.all(result.players.map(async (playerUid) => {
        const isWinner = playerUid === uid;
        const userRef = db.collection('users').doc(playerUid);
        await db.runTransaction(async (t) => {
          const userSnap = await t.get(userRef);
          const u = userSnap.data() || {};
          const xpGain = isWinner ? XP_WIN : XP_LOSE;
          const newXp = (u.xp || 0) + xpGain;
          const newNiveau = Math.floor(newXp / 100) + 1;

          t.update(userRef, {
            xp: newXp,
            niveau: newNiveau,
            pieces: (u.pieces || 0) + (isWinner ? PIECES_WIN : 0),
            victoires: (u.victoires || 0) + (isWinner ? 1 : 0),
            defaites: (u.defaites || 0) + (isWinner ? 0 : 1),
            partiesJouees: (u.partiesJouees || 0) + 1,
          });
        });
      }));
    }

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('Erreur move-token:', err.message);
    const knownErrors = [
      'not_your_turn', 'no_pending_roll', 'invalid_token',
      'token_already_finished', 'need_six_to_exit', 'overshoot', 'game_not_found',
    ];
    const status = knownErrors.includes(err.message) ? 400 : 500;
    return res.status(status).json({ error: err.message || 'internal_error' });
  }
}
