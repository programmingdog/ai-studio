type ReversalSeed = {
  title: string;
  genre: string;
  theme: string;
  setting: string;
  settingLock: string;
  victim: string;
  victimRole: string;
  accuser: string;
  accuserRole: string;
  judge: string;
  judgeRole: string;
  witness: string;
  witnessRole: string;
  humiliation: string;
  allegation: string;
  plantedEvidence: string;
  firstClue: string;
  counterClaim: string;
  finalEvidence: string;
  motive: string;
  consequence: string;
  ending: string;
};

const seeds: readonly ReversalSeed[] = [
  {
    title: "护士被诬换药害人，三重药签撕开真相",
    genre: "医疗伦理悬疑",
    theme: "守护医者清白与揭露利益嫁祸",
    setting: "市立医院VIP病房与配药间",
    settingLock: "现代医院VIP病房连接透明配药间，白色病床、输液架、药品推车、门禁读卡器与监护屏位置固定，冷白日光灯与窗外午后自然光交叠。",
    victim: "林乔", victimRole: "责任护士",
    accuser: "赵曼", accuserRole: "患者侄女",
    judge: "顾主任", judgeRole: "科室主任",
    witness: "陈姨", witnessRole: "同病房患者",
    humiliation: "赵曼嫌林乔动作慢，当众把药盒扫落在地，顾主任推门时她立刻蹲下帮忙捡药并假装体贴",
    allegation: "私自更换患者进口药并导致监护数据异常",
    plantedEvidence: "一支拆封的错误药剂和写有林乔工号的空药签被塞进她的护士服口袋",
    firstClue: "陈姨手机里拍到赵曼在林乔离开后单独推过药车",
    counterClaim: "赵曼反咬陈姨和林乔串通，称偷拍视频时间错误，并拿出林乔签过字的领药单",
    finalEvidence: "药房系统显示领药单二维码在签字后被二次打印，门禁记录与药瓶冷链芯片同时锁定赵曼的药代男友进入配药间",
    motive: "赵曼想制造医疗事故逼医院高额赔偿，并替男友销掉一批临期药",
    consequence: "保卫科封存药品并报警，赵曼与男友被带走调查，顾主任公开撤销对林乔的停职决定",
    ending: "顾主任向林乔郑重道歉，病房患者把散落的药盒一只只递回她手中，林乔重新推着药车走进晨光",
  },
  {
    title: "保洁叔被诬偷助学金，编号钞票连翻两案",
    genre: "校园现实悬疑",
    theme: "维护劳动者尊严与揭露校园伪善",
    setting: "重点中学行政楼与奖学金办公室",
    settingLock: "明亮校园行政楼走廊连接奖学金办公室和清洁工具间，木质文件柜、信封保险箱、监控摄像头、保洁车与门禁机位置固定。",
    victim: "老魏", victimRole: "校园保洁员",
    accuser: "孙倩", accuserRole: "学生会财务负责人",
    judge: "韩老师", judgeRole: "德育主任",
    witness: "许言", witnessRole: "受助学生",
    humiliation: "孙倩逼老魏跪着擦掉她故意踩出的泥印，韩老师出现时她马上扶老人起身并声称自己一直在帮忙",
    allegation: "偷走贫困生助学金信封",
    plantedEvidence: "装有编号钞票的红色信封被藏进老魏工具车底层",
    firstClue: "许言拍社团素材时录到孙倩借口借胶带独自靠近工具车",
    counterClaim: "孙倩称视频是许言为了保住助学资格剪辑的，并展示老魏当天刷开办公室的门禁记录",
    finalEvidence: "门禁后台证明老魏的卡被复制，复印室废纸上留有孙倩测试复制卡的编号，信封封口还粘着她比赛用的金色亮片",
    motive: "孙倩挪用助学金填补竞赛报名费亏空，企图把责任推给最难自证的保洁员",
    consequence: "学校报警并启动财务审计，孙倩被撤职调查，韩老师恢复老魏工作并补发误工费",
    ending: "许言带受助学生向老魏鞠躬，老魏把工具车推过重新擦亮的荣誉墙，墙面映出他挺直的背影",
  },
  {
    title: "直播助理被诬泄密，镜面倒影锁死真凶",
    genre: "直播电商职场悬疑",
    theme: "反击职场栽赃与守护原创成果",
    setting: "头部直播公司的样品间与直播棚",
    settingLock: "高层直播公司内设霓虹直播棚、玻璃样品间、化妆台、产品保险柜与多机位导播屏，紫蓝灯带和补光灯方向固定。",
    victim: "苏禾", victimRole: "直播助理",
    accuser: "唐薇", accuserRole: "头部主播",
    judge: "陆总", judgeRole: "公司负责人",
    witness: "阿凯", witnessRole: "导播",
    humiliation: "唐薇嫌苏禾整理样品太慢，将整盘试用装推翻让她蹲地收拾，陆总进棚时又立刻夸她工作辛苦",
    allegation: "把未上市新品配方和直播脚本泄露给竞品",
    plantedEvidence: "存有泄密文件的银色U盘被放进苏禾随身化妆包",
    firstClue: "阿凯发现直播回放边缘的化妆镜倒影拍到唐薇碰过苏禾的包",
    counterClaim: "唐薇称倒影只是自己递口红，并亮出泄密邮件由苏禾账号发送的后台截图",
    finalEvidence: "邮件服务器显示发送设备绑定唐薇私人手机，U盘文件创建时间早于苏禾入职，原始直播多机位还拍到唐薇拔下U盘后擦拭指纹",
    motive: "唐薇已签约竞品，想用泄密风波带走团队并夺走新品首发违约赔偿",
    consequence: "陆总冻结唐薇权限并提交法务，平台暂停其账号，苏禾获得新品项目署名与晋升",
    ending: "苏禾独自站上直播测试位讲完第一段产品故事，阿凯亮起绿灯，曾经压住她的主灯第一次照在她脸上",
  },
  {
    title: "寡妇被诬兑水卖奶，冷链封签反转全村",
    genre: "乡村现实伦理",
    theme: "守护农户信誉与揭露合作社利益侵占",
    setting: "山村奶牛合作社收奶站",
    settingLock: "清晨山村收奶站设不锈钢奶罐、检测台、冷链车、电子秤、封签柜和排队雨棚，薄雾与暖色晨光贯穿场景。",
    victim: "柳春梅", victimRole: "独自养牛的寡妇",
    accuser: "马桂芬", accuserRole: "合作社会计",
    judge: "赵站长", judgeRole: "收奶站负责人",
    witness: "小满", witnessRole: "兽医实习生",
    humiliation: "马桂芬当众嫌柳春梅身上有牛棚味，故意把检测杯踢翻让她蹲地擦洗，站长到来时又假装替她说情",
    allegation: "往原奶里兑水骗取合作社货款",
    plantedEvidence: "一袋增重用的透明液体和异常检测样本被塞进柳春梅的奶罐车夹层",
    firstClue: "小满的牛只健康记录显示当晨乳脂率正常，且他看见马桂芬单独调换过取样杯",
    counterClaim: "马桂芬指责小满收了柳春梅好处，并拿出带柳春梅指纹的异常样本瓶",
    finalEvidence: "冷链封签扫码记录显示样本瓶来自另一户，检测台称重日志与车载行车影像共同拍到马桂芬调包并把液体塞入夹层",
    motive: "马桂芬长期压低散户奶价，把差额转给亲属经营的奶场，柳春梅拒绝签低价合同后成为栽赃目标",
    consequence: "合作社召开村民大会撤换会计并追回差额，警方带走账本，赵站长公开恢复柳春梅的优质供应资格",
    ending: "第一缕阳光照进收奶站，村民主动把柳春梅的奶罐推到队伍最前，小满为她贴上新的金色合格封签",
  },
  {
    title: "古玩学徒被诬调包，玉扣暗纹揭开师门局",
    genre: "古玩行业悬疑",
    theme: "守护师徒信义与揭露监守自盗",
    setting: "老城古玩拍卖预展厅与修复室",
    settingLock: "中式古玩预展厅连接恒温修复室，红木展柜、放大镜灯、保险箱、紫外鉴定台和编号托盘位置固定，暖黄射灯营造压迫感。",
    victim: "沈砚", victimRole: "年轻修复学徒",
    accuser: "杜蓉", accuserRole: "拍卖行经理",
    judge: "秦师傅", judgeRole: "首席鉴定师兼师父",
    witness: "程墨", witnessRole: "摄影记录员",
    humiliation: "杜蓉逼沈砚用手捧着碎瓷跪地道歉，秦师傅进门时她立即改口说是在指导新人保护文物",
    allegation: "把待拍古玉调包成赝品准备私卖真品",
    plantedEvidence: "一枚高仿古玉和私下交易名片被藏进沈砚工具箱",
    firstClue: "程墨的微距预展照片显示真玉在入修复室前已经换过挂绳，调包早于沈砚接手",
    counterClaim: "杜蓉称照片色差不可靠，并拿出只有沈砚指纹的保险箱托盘和他与买家的聊天截图",
    finalEvidence: "真玉内侧微雕暗纹对应杜蓉私人保单编号，聊天截图字体包来自她的电脑，恒温柜重量曲线记录了她夜间取走真玉的准确时刻",
    motive: "杜蓉因地下投资亏损，计划让真玉骗保后转卖，并借学徒身份掩盖专业操作",
    consequence: "拍卖行报警封存真玉和保单，杜蓉被停职调查，秦师傅当众收回对沈砚的逐出师门决定",
    ending: "秦师傅把象征出师的旧放大镜交给沈砚，师徒在修复灯下重新拼合那只被摔碎的瓷盏",
  },
  {
    title: "老厨师被诬下毒，过敏餐签连破夺店阴谋",
    genre: "餐饮商战伦理",
    theme: "尊重匠人清白与揭露夺店阴谋",
    setting: "百年饭店后厨与宴会厅",
    settingLock: "百年饭店明档后厨连接中式宴会厅，灶台、调料架、过敏餐专用蓝色餐具、传菜口与冷库门位置固定，暖黄灯光和灶火形成强对比。",
    victim: "何师傅", victimRole: "老字号主厨",
    accuser: "蒋莉", accuserRole: "新任运营经理",
    judge: "方老板", judgeRole: "饭店继承人",
    witness: "小北", witnessRole: "传菜员",
    humiliation: "蒋莉嫌何师傅守旧，把他熬了整夜的高汤倒掉逼他重做，方老板出现时又假装替老人擦汗",
    allegation: "故意在贵宾过敏餐里加入花生粉报复饭店改革",
    plantedEvidence: "半袋花生粉和写着贵宾桌号的餐签被塞进何师傅围裙口袋",
    firstClue: "小北记得过敏餐一直使用蓝盘，而出事菜品送到宴会厅时已经换成白盘",
    counterClaim: "蒋莉称小北端错盘后怕担责撒谎，并拿出何师傅亲手签字的出菜检查表",
    finalEvidence: "传菜口感应器记录白盘从经理专用通道进入，餐签油墨来自蒋莉办公室打印机，冷库摄像头反光拍到她把花生粉塞进围裙",
    motive: "蒋莉想制造食品事故压低饭店估值，帮助资本方廉价收购并拿走佣金",
    consequence: "方老板停止收购谈判并报警，蒋莉被带走，受害贵宾澄清何师傅没有接触出事菜品",
    ending: "何师傅重新点燃灶火，小北把蓝色过敏餐盘郑重放到他面前，宴会厅响起客人等待开席的掌声",
  },
  {
    title: "救援志愿者被诬吞款，直播反光照出假慈善",
    genre: "公益救援悬疑",
    theme: "守护善意与揭露慈善作秀",
    setting: "暴雨灾区物资中转站",
    settingLock: "暴雨后的体育馆物资中转站堆放纸箱、折叠床、捐款登记台、直播灯和带电子锁的临时财务柜，雨声与应急灯贯穿环境。",
    victim: "周岚", victimRole: "一线救援志愿者",
    accuser: "许珊", accuserRole: "公益主播",
    judge: "罗队", judgeRole: "救援队负责人",
    witness: "豆豆", witnessRole: "受灾少年",
    humiliation: "许珊关掉直播后逼满身泥水的周岚跪着整理物资，罗队进入时她马上打开直播拥抱周岚塑造姐妹情",
    allegation: "偷拿直播募捐现金并私藏高价药品",
    plantedEvidence: "一沓做过标记的现金和两盒急救药被藏进周岚睡袋",
    firstClue: "豆豆用旧相机拍到许珊助理在无人时掀开周岚睡袋",
    counterClaim: "许珊称豆豆为了感谢周岚故意摆拍，并展示周岚独自开启财务柜的电子记录",
    finalEvidence: "直播补光灯镜面反射出许珊输入管理员码，电子锁云端记录证明周岚账号被远程授权，现金上的荧光标记来自许珊事先拍摄的剧本素材",
    motive: "许珊准备制造志愿者贪污话题炒热账号，同时掩盖她把部分善款转入个人公司的事实",
    consequence: "平台冻结直播收益并移交警方，救援队公布完整账目，罗队恢复周岚物资负责人身份",
    ending: "周岚把追回的药送到临时医务点，豆豆将拍立得照片递给她，照片背面写着真正的英雄不需要滤镜",
  },
  {
    title: "女研究员被诬删数据，硬件密钥反杀署名局",
    genre: "科研职场悬疑",
    theme: "捍卫科研诚信与女性成果署名",
    setting: "生物科技实验室与项目答辩室",
    settingLock: "现代生物科技实验室连接玻璃答辩室，超净台、样本冰箱、数据终端、硬件密钥柜和投影屏位置固定，冷蓝实验光与白色顶灯统一。",
    victim: "姜宁", victimRole: "青年研究员",
    accuser: "秦博士", accuserRole: "项目副负责人",
    judge: "严教授", judgeRole: "项目首席科学家",
    witness: "叶舟", witnessRole: "实验设备工程师",
    humiliation: "秦博士逼姜宁独自清洗全部实验器皿并撕掉她的署名页，严教授进来时却夸她是团队核心",
    allegation: "删除关键实验数据并把未发表成果发给竞争机构",
    plantedEvidence: "带有外发文件的移动硬盘和恢复删除数据的脚本被放进姜宁储物柜",
    firstClue: "叶舟发现删除操作发生时姜宁正在无菌室，门禁与设备维护影像都能证明她双手未接触终端",
    counterClaim: "秦博士称姜宁提前设置远程脚本，并展示所有操作均由她账号和密码完成的审计日志",
    finalEvidence: "终端必须插入实名硬件密钥才能删除数据，密钥柜称重与芯片日志锁定秦博士取走姜宁密钥，外发文件水印还保留他的隐藏作者编号",
    motive: "秦博士想抹去姜宁的第一作者资格，把成果带去即将入职的竞争公司换取职位",
    consequence: "学校科研诚信委员会封存设备并撤销秦博士项目权限，严教授恢复姜宁署名并公开更正答辩材料",
    ending: "姜宁亲手把自己的名字投到答辩屏第一页，叶舟打开实验室百叶窗，晨光落在重新启动的数据曲线上",
  },
  {
    title: "伴娘被诬偷婚镯，婚礼灯控记录逆转亲情局",
    genre: "婚礼家庭伦理悬疑",
    theme: "守护友情尊严与揭露彩礼操控",
    setting: "湖畔酒店新娘套房与婚礼宴会厅",
    settingLock: "湖畔酒店新娘套房连接金色宴会厅，化妆台、首饰盒、伴娘礼服架、智能灯控面板和走廊装饰镜位置固定，柔粉晨光逐渐过渡到宴会暖金灯。",
    victim: "乔安", victimRole: "新娘多年好友兼伴娘",
    accuser: "冯慧", accuserRole: "新郎姐姐",
    judge: "林悦", judgeRole: "新娘",
    witness: "米可", witnessRole: "婚礼化妆师",
    humiliation: "冯慧嫌乔安出身普通，故意把礼服踩脏让她蹲地处理，林悦进门时又装作亲热地替乔安整理头纱",
    allegation: "偷走婆家祖传婚镯并准备在婚礼前逃离酒店",
    plantedEvidence: "祖传金镯和一张二手奢侈品店名片被藏进乔安化妆箱夹层",
    firstClue: "米可拍妆面教程时录到冯慧拿走首饰盒，时间早于乔安进入套房",
    counterClaim: "冯慧称米可为了流量拼接视频，并拿出乔安向二手店询价的聊天记录作为预谋证据",
    finalEvidence: "酒店智能灯控记录证明询价时乔安手机留在宴会厅播放音乐，聊天账号登录设备属于冯慧，走廊装饰镜还完整反射她把金镯塞入化妆箱",
    motive: "冯慧想逼林悦赶走唯一反对天价彩礼的好友，并借失窃要求女方追加赔偿",
    consequence: "林悦当场暂停婚礼并要求清查彩礼协议，冯慧被酒店保安控制，新郎公开退还不合理款项",
    ending: "林悦向乔安道歉并请她重新戴好头纱，两人没有立刻走上礼台，而是并肩走到湖边重新决定这场婚礼是否继续",
  },
  {
    title: "护工被诬虐待老人，健康手环录下夺房真相",
    genre: "养老家庭伦理悬疑",
    theme: "守护照护者清白与老年人财产尊严",
    setting: "高端养老院康复区与家属会客室",
    settingLock: "高端养老院康复区连接玻璃会客室，康复扶手、药柜、护理记录屏、健康手环充电座和轮椅位置固定，柔和日光与暖白护理灯保持连续。",
    victim: "方琴", victimRole: "资深护工",
    accuser: "沈梅", accuserRole: "老人长女",
    judge: "郑院长", judgeRole: "养老院院长",
    witness: "老周", witnessRole: "同区住养老人",
    humiliation: "沈梅私下逼方琴给母亲洗完衣服再擦会客室，院长出现时她立刻握住方琴的手夸她辛苦",
    allegation: "粗暴推倒老人造成手臂淤青，并偷拿老人银行卡",
    plantedEvidence: "老人的银行卡和一只撕裂袖扣被塞进方琴护理柜",
    firstClue: "老周回忆老人摔倒前沈梅曾强行拉她按手印，康复区镜面也拍到方琴当时在另一张床旁",
    counterClaim: "沈梅称老周记忆混乱、镜面角度失真，并播放一段方琴提高音量催老人起身的视频",
    finalEvidence: "老人健康手环连续录下沈梅逼签赠房协议和推搡声，心率时间轴与护理定位完全吻合，银行卡取款影像也显示沈梅戴着撕裂袖扣",
    motive: "沈梅急于在弟弟回国前转走存款并取得房产，故意制造护工虐待事件隔绝母亲与外界",
    consequence: "院长报警并联系法律援助，赠房协议被叫停，沈梅失去临时监护权限，方琴获得书面澄清",
    ending: "老人把健康手环轻轻戴回方琴腕上表示信任，老周推着轮椅陪她们走进康复花园，阳光照亮三人交叠的手",
  },
];

const visualStyle = "竖屏现实主义精品短剧，电影级写实质感，冷暖光线随真相推进变化，强调微表情、关键物证特写和情绪递进。";

function characterLock(name: string, role: string, index: number): string {
  const appearances = [
    "面容克制坚韧，眼神清澈，情绪受压时仍保留尊严",
    "妆容精致，眼神锋利，能在伪善与慌乱之间快速变脸",
    "气质严肃稳重，眉眼紧绷，判断变化通过细微表情呈现",
    "面容真诚敏锐，观察细致，发现证据时神态坚定",
  ];
  return `${name}｜${role}｜${appearances[index]}；符合${role}身份的固定服装与随身物件，全剧颜色和款式保持一致`;
}

function buildSource(seed: ReversalSeed): string {
  const roles = [
    { id: "CHAR_001", name: seed.victim, role: seed.victimRole, lock: characterLock(seed.victim, seed.victimRole, 0), voice: "克制真诚，受冤时由颤抖逐渐转为坚定" },
    { id: "CHAR_002", name: seed.accuser, role: seed.accuserRole, lock: characterLock(seed.accuser, seed.accuserRole, 1), voice: "表面柔和、私下尖刻，败露时语速加快" },
    { id: "CHAR_003", name: seed.judge, role: seed.judgeRole, lock: characterLock(seed.judge, seed.judgeRole, 2), voice: "沉稳有权威，误判时严厉，醒悟后诚恳" },
    { id: "CHAR_004", name: seed.witness, role: seed.witnessRole, lock: characterLock(seed.witness, seed.witnessRole, 3), voice: "朴实清晰，面对质疑仍坚持事实" },
  ];
  const shotPlans = [
    { scene: 1, size: "全景转中近景", move: "横移跟拍后急停", visual: `${seed.humiliation}。镜头先让观众看清${seed.accuser}真实态度，再用门响和变脸完成强烈反差。`, dialogue: `- CHAR_002｜${seed.accuser}（私下刻薄）：“别装可怜，把该做的事马上做完！”\n- CHAR_002｜${seed.accuser}（瞬间温柔）：“我正帮${seed.victim}呢，你别误会。”`, action: `${seed.accuser}施压羞辱→${seed.victim}忍耐完成动作→门外传来脚步→${seed.accuser}立刻收手变脸→${seed.judge}进入观察`, sound: "环境操作声、脚步逼近声、音乐由压抑突然收紧" },
    { scene: 1, size: "人物近景与反应特写", move: "正反打缓慢推进", visual: `${seed.accuser}抢先向${seed.judge}诉苦，把自己的恶意包装成体谅；${seed.victim}试图解释却被打断，${seed.judge}第一次露出不耐。`, dialogue: `- CHAR_002｜${seed.accuser}（委屈伪善）：“我一直替人着想，可有人偏要把好心说成恶意。”\n- CHAR_001｜${seed.victim}（压抑辩解）：“事情不是你说的那样，请让我讲完。”`, action: `${seed.accuser}靠近${seed.judge}低声诉苦→${seed.victim}抬头解释→${seed.accuser}故意打断→${seed.judge}皱眉示意安静→${seed.victim}被迫退后`, sound: "压低的诉说声、短促打断声、克制弦乐持续" },
    { scene: 1, size: "手部特写转过肩镜头", move: "隐蔽跟拍", visual: `趁${seed.judge}转身处理事务，${seed.accuser}取出${seed.plantedEvidence}，避开正面视线完成藏匿，并回头确认无人注意。`, dialogue: `- CHAR_002｜${seed.accuser}（阴冷低语）：“证据都在你这里，这回谁也救不了你。”`, action: `${seed.accuser}确认众人背身→取出栽赃物→擦掉表面痕迹→藏入目标位置→恢复原状若无其事离开`, sound: "细微开合声、衣料摩擦声、心跳低频与远处人声" },
    { scene: 1, size: "中景转快速特写", move: "急推与摇镜", visual: `关键物品或数据被宣布丢失，${seed.accuser}先制造慌乱，再“不经意”提出${seed.victim}与${seed.allegation}有关，引导所有目光转向受害者。`, dialogue: `- CHAR_002｜${seed.accuser}（惊慌煽动）：“怎么会不见？刚才只有${seed.victim}接近过这里。”\n- CHAR_003｜${seed.judge}（严肃）：“先别走，所有人把经过说清楚。”`, action: `异常被发现→${seed.accuser}高声吸引注意→暗示${seed.victim}可疑→${seed.judge}封住出口→众人视线集中到${seed.victim}`, sound: "警示或翻找声、人群低语骤起、鼓点加速" },
    { scene: 2, size: "搜索中景转物证大特写", move: "跟随搜索后定镜", visual: `在${seed.accuser}精准指引下，众人从${seed.victim}的私人物品中找出${seed.plantedEvidence}。物证占据画面中心，表面上完全坐实指控。`, dialogue: `- CHAR_003｜${seed.judge}（震惊质问）：“东西为什么会在你这里？”\n- CHAR_002｜${seed.accuser}（痛心伪装）：“我替你说了那么多话，你怎么能做这种事？”`, action: `${seed.accuser}指向藏匿位置→${seed.judge}亲手搜索→栽赃物被取出→${seed.victim}震惊后退→${seed.accuser}故作痛心靠近`, sound: "抽屉或包袋开启声、物证落桌重响、音乐瞬间停顿" },
    { scene: 2, size: "群像中景转受害者特写", move: "环绕半圈后压近", visual: `${seed.victim}反复否认${seed.allegation}，但${seed.accuser}用表面证据连续逼问，${seed.judge}作出错误处分。镜头停在受害者孤立无援的表情上。`, dialogue: `- CHAR_001｜${seed.victim}（含泪坚定）：“我没有做过，东西也不是我放的。”\n- CHAR_003｜${seed.judge}（失望严厉）：“证据就在眼前，在查清前你必须停下所有工作。”`, action: `${seed.victim}举手否认→${seed.accuser}逐项指认物证→周围人后退疏远→${seed.judge}宣布处分→${seed.victim}独自站在画面中央`, sound: "辩解声被议论淹没、低沉弦乐下坠、结尾保留呼吸声" },
    { scene: 2, size: "设备画面特写转双人近景", move: "从证据缓慢推向人物", visual: `${seed.witness}鼓起勇气拿出第一条反证：${seed.firstClue}。现场第一次安静，${seed.victim}看见希望，${seed.accuser}的笑容短暂停顿。`, dialogue: `- CHAR_004｜${seed.witness}（紧张但清楚）：“先别定罪，我这里有一段能改变时间线的证据。”\n- CHAR_001｜${seed.victim}（克制激动）：“请把完整内容放出来，让大家自己判断。”`, action: `${seed.witness}穿过人群上前→展示原始记录→放大关键细节→${seed.judge}重新核对时间→${seed.accuser}下意识握紧双手`, sound: "设备播放声、议论逐渐停止、音乐出现第一次上扬" },
    { scene: 2, size: "对峙近景与证据插入镜头", move: "快速正反打", visual: `${seed.accuser}迅速反击：${seed.counterClaim}。她把第一条反证解释成串通或误差，现场立场再次摇摆，${seed.victim}刚升起的希望被压回去。`, dialogue: `- CHAR_002｜${seed.accuser}（强势反咬）：“这份东西根本证明不了清白，反而说明你们早就串通好了！”\n- CHAR_003｜${seed.judge}（迟疑审慎）：“第一条证据还有漏洞，继续查原始记录。”`, action: `${seed.accuser}夺回话语权→指出反证漏洞→抛出第二份表面证据→围观者再次动摇→${seed.judge}要求核验源数据`, sound: "急促反驳声、证据拍桌声、悬念音乐二次收紧" },
    { scene: 3, size: "多屏特写转主角群像", move: "沿证据链连续滑动", visual: `${seed.witness}与${seed.judge}调取不可篡改的深层记录：${seed.finalEvidence}。多项信息按时间顺序闭环，镜头回扣此前藏匿动作，完成终极反转。`, dialogue: `- CHAR_004｜${seed.witness}（笃定）：“单独一条可以狡辩，但时间、设备和物证三条记录不可能同时说谎。”\n- CHAR_003｜${seed.judge}（震怒）：“真正布置这一切的人不是${seed.victim}，是你！”`, action: `调出第一项原始记录→叠加第二项时间信息→核对物证唯一特征→回放栽赃关键动作→${seed.judge}转身直指${seed.accuser}`, sound: "连续验证提示音、心跳声停止、真相揭示重音爆发" },
    { scene: 3, size: "反派近景转全景", move: "急推后缓慢拉开", visual: `${seed.accuser}先否认、再崩溃，最终被证据逼出动机：${seed.motive}。${seed.victim}没有争吵，只平静要求对方直面伤害。`, dialogue: `- CHAR_002｜${seed.accuser}（慌乱失控）：“不是我！这些记录都能伪造！”\n- CHAR_001｜${seed.victim}（平静有力）：“你算准了我最难自证，才把所有脏水都泼向我。”`, action: `${seed.accuser}否认并后退→试图夺走证据→被众人拦下→动机相关资料曝光→${seed.victim}站直身体完成质问`, sound: "失控喊声、纸张散落声、音乐从激烈转为沉重" },
    { scene: 3, size: "处置群像转道歉近景", move: "稳定横移", visual: `${seed.consequence}。处置完成后，${seed.judge}走到${seed.victim}面前承认自己只相信表面证据造成了二次伤害。`, dialogue: `- CHAR_003｜${seed.judge}（愧疚郑重）：“我把找到东西当成真相，却没有先相信一个人的品格，我向你道歉。”\n- CHAR_001｜${seed.victim}（克制）：“道歉要留下，查证的规矩也要留下。”`, action: `相关人员接管现场→栽赃物被正式封存→${seed.accuser}接受处置→${seed.judge}当众道歉→${seed.victim}提出修正规则`, sound: "交接确认声、人群安静、温暖但克制的弦乐进入" },
    { scene: 3, size: "中景转环境全景", move: "缓慢后退拉远", visual: `${seed.ending}。最后回到最初受辱的位置，让相同空间以新的站位和光线完成情绪回响。`, dialogue: `- CHAR_004｜${seed.witness}（温和）：“清白也许会迟到，但有人愿意把细节记住，真相就不会消失。”\n- CHAR_001｜${seed.victim}（释然坚定）：“以后遇到被冤枉的人，我也会先听完他的话。”`, action: `${seed.victim}完成新的具体行动→${seed.witness}递回重要物件→两人相视点头→日常秩序重新启动→镜头拉远定格新的关系`, sound: "真实环境声恢复、轻柔主题音乐上扬、尾音自然渐弱" },
  ];
  const characterSections = roles.map((role, index) => `【角色 ${role.id}】\n名称：${role.name}\n角色定位：${role.role}\n性别与年龄：${index === 0 || index === 1 ? "女，25-45岁" : "未限定，25-60岁"}\n外貌锁定：${role.lock.split("；")[0]}\n服装锁定：${role.lock.split("；")[1]}\n声音锁定：${role.voice}`).join("\n\n");
  const sceneSections = [
    `【场景 SCENE_001】\n名称：${seed.setting}·压制与栽赃\n场景锁定：${seed.settingLock} 保持入口、主要道具和人物行动方向连续，前半段光线压抑。`,
    `【场景 SCENE_002】\n名称：${seed.setting}·搜证与误判\n场景锁定：${seed.settingLock} 搜证区域突出栽赃物和人物距离，冷色光加强孤立感。`,
    `【场景 SCENE_003】\n名称：${seed.setting}·终极对质\n场景锁定：${seed.settingLock} 对质区域可同时展示多项原始证据，真相揭开后光线逐渐转暖。`,
  ].join("\n\n");
  const locks = roles.map((role) => `- ${role.id}｜${role.lock}`).join("\n");
  const references = roles.map((role) => `${role.id}｜${role.name}`).join("；");
  const shotSections = shotPlans.map((shot, index) => {
    const start = index * 10;
    const end = start + 10;
    const sceneId = `SCENE_00${shot.scene}`;
    const actionBeats = shot.action.split("→");
    return `第${index + 1}段（${start}～${end}秒）\n屏幕比例：9:16\n景别：${shot.size}\n机位：平视，关键物证使用俯拍或过肩补充\n运镜：${shot.move}\n画风设定：${visualStyle}\n场景引用：${sceneId}｜${seed.setting}\n场景锁定：${seed.settingLock}\n人物引用：${references}\n人物锁定：\n${locks}\n画面：${shot.visual}\n口播台词：\n${shot.dialogue}\n动作：${shot.action}\n节奏设计：0～3秒：${actionBeats[0]}；3～7秒：${actionBeats.slice(1, -1).join("，随后")}；7～10秒：${actionBeats.at(-1)}\n声音：${shot.sound}\n约束：角色五官、发型、服装和关键物证全程一致；动作与口型自然；证据位置和时间逻辑连续；无多余人物、畸形、穿模、字幕和水印。`;
  }).join("\n\n");
  return `一、项目剧情\n\n标题：${seed.title}\n主题：${seed.theme}\n基调：压抑、委屈、误判、希望、二次绝望、真相爆发、尊严回归\n一句话梗概：${seed.victim}遭${seed.accuser}精心栽赃“${seed.allegation}”，表面证据一度坐实；第一条反证又被反咬推翻，最终多重原始记录完成终极反转并揭开真正动机。\n故事概要：在${seed.setting}，${seed.accuser}先压制${seed.victim}并在人前伪装善意，随后用${seed.plantedEvidence}制造完整栽赃链。${seed.judge}因表面证据误判，令${seed.victim}跌入清白尽失的情绪谷底。${seed.witness}带来“${seed.firstClue}”完成第一次翻案，却被${seed.accuser}以“${seed.counterClaim}”再次反咬。最终，“${seed.finalEvidence}”形成不可篡改的证据闭环，揭露${seed.motive}，让诬陷者承担后果，也迫使误判者反思。\n屏幕比例：9:16\n画风设定：${visualStyle}\n\n二、全局角色库\n\n${characterSections}\n\n三、全局场景库\n\n${sceneSections}\n\n四、分镜列表\n\n${shotSections}`;
}

export const hotReversalScriptSources = seeds.map((seed) => ({
  filename: `${seed.title}.txt`,
  source: buildSource(seed),
}));

export const hotReversalScriptTitles = new Set(seeds.map((seed) => seed.title));

export const retiredHotScriptTitles = new Set([
  "渡骸",
  "齐心拉车",
  "零点回声",
  "末世重生：夺回空间手链与疯狂囤货",
  "天山胜利隧道建设传奇",
]);
