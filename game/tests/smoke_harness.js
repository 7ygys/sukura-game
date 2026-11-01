const H = require('./harness');
H.group('脚手架自检');
H.ok('引擎能加载', !!H.E && !!H.E.rules);
H.eq('开局牌数', H.cardTotal(H.fresh()), 20);
const s = H.withHand(['01-yurina-o-n-1']);
H.eq('手牌 1 张', s.players[0].hand.length, 1);
H.report();
