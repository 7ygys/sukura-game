/* ============================================================
 * engine/rng.js —— 随机数（可复现）
 *
 * 为什么不用 Math.random()：
 *   Math.random() 的结果没法重放。调试时"这张牌怎么来的"就查不清。
 *   这里用「种子 + 线性同余」，同一个种子必然产生同一串随机数。
 * ============================================================ */
(function (root) {
  const Engine = (root.Engine = root.Engine || {});

  /** 创建一个随机函数，返回 0~1 之间的小数 */
  function makeRng(seed) {
    let s = seed >>> 0;
    if (s === 0) s = 1;
    return function () {
      // 数值来自 Numerical Recipes 的线性同余式
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** Fisher–Yates 洗牌：从后往前，每张和前面随机一张交换 */
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  Engine.rng = { makeRng, shuffle };
})(typeof window !== 'undefined' ? window : globalThis);
