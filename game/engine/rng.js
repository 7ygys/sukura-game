/* ============================================================
 * engine/rng.js —— 随机与洗牌
 *
 * 决定：**不使用种子**。
 *
 * 理由：
 *   1. 种子一旦被知道，牌序就能被算出来（对方能作弊）
 *   2. 联机设计里双方各自洗自己的牌，本来就不需要共享随机源
 *   3. 这个游戏不做悔棋 / 重放，所以"可复现"没有收益
 *
 * 所以直接用 Math.random()，完全随机。
 * ============================================================ */
(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /** 洗牌：Fisher–Yates，从后往前，每张和前面随机一张交换 */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** 从数组里随机取一个 */
  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  Engine.rng = { shuffle, pick };
})(typeof window !== 'undefined' ? window : globalThis);
