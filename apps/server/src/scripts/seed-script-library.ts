import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import mammoth from "mammoth";
import { Connection, createConnection, RowDataPacket } from "mysql2/promise";
import { loadDatabaseConfig } from "../config/environment";
import { hotReversalScriptSources, hotReversalScriptTitles, retiredHotScriptTitles } from "./hot-reversal-scripts";

type Concept = readonly [
  title: string,
  lead: string,
  partner: string,
  setting: string,
  inciting: string,
  reversal: string,
  ending: string,
];

interface CategorySeed {
  code: string;
  genre: string;
  theme: string;
  tone: string;
  concepts: readonly Concept[];
}

interface CategoryRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  script_count: number | string;
}

const durationSeconds = 240;
const fixedShotSeconds = 10;
const minimumScriptsPerCategory = 5;
const hotCategoryCode = "hot-fans";

const seeds: readonly CategorySeed[] = [
  { code: "modern-city", genre: "现代都市", theme: "普通人的选择与善意", tone: "现实温暖", concepts: [
    ["末班地铁的伞", "许舟", "程雾", "末班地铁", "许舟捡到一把夹着医院缴费单的旧伞", "失主程雾其实正沿线寻找替父亲垫付医药费的陌生人", "两人在终点站找到真正的好心人，也决定把善意继续传下去"],
    ["天台修灯人", "周野", "林禾", "老旧写字楼天台", "物业电工周野发现每晚坏掉的灯都被人重新点亮", "点灯人林禾是在用灯光给失眠的独居老人报平安", "两人说服物业保留这套约定，并建立楼内互助群"],
    ["外卖单上的留言", "陈默", "苏晴", "雨夜商业街", "骑手陈默收到一张写着救命暗号的特殊订单", "顾客苏晴并未被困，而是在替遭遇家暴的邻居求助", "陈默协助警方救出邻居，迟到的订单也得到所有人理解"],
    ["凌晨便利店", "唐宁", "高叔", "二十四小时便利店", "唐宁连续七晚遇见只买一瓶热牛奶的沉默老人", "老人是在等离家多年的女儿经过这条街", "唐宁用旧会员信息联系上女儿，让清晨的店门口迎来团聚"],
    ["电梯停在十三层", "顾言", "孟夏", "都市公寓", "顾言每天回家时电梯都会无故停在不存在的十三层", "维修员孟夏发现是独居孩子用旧按钮向楼下求助", "两人及时救下突发疾病的孩子母亲，并修复邻里关系"],
  ]},
  { code: "sweet-romance", genre: "甜宠言情", theme: "真诚与双向奔赴", tone: "轻甜治愈", concepts: [
    ["拿错的咖啡", "沈知夏", "陆川", "街角咖啡馆", "沈知夏拿错了写有求婚计划的咖啡杯", "计划并非陆川替自己准备，而是帮朋友彩排", "误会解除后陆川把练习过的话改成了对沈知夏的正式告白"],
    ["合租日历", "乔安", "贺屿", "合租公寓", "乔安发现冰箱日历上每天都多一句匿名提醒", "看似冷淡的室友贺屿一直悄悄记得她的重要日子", "乔安在日历最后一格写下约会邀请，两人一起翻到新月份"],
    ["未发送的语音", "林晚", "江澈", "电台录音室", "林晚误把一段告白语音投进听众信箱", "当晚点歌人正是暗恋她多年的搭档江澈", "两人在直播结束前用同一首歌回应彼此"],
    ["面包店靠窗座", "温梨", "顾南", "社区面包店", "温梨每天为固定空座留下一只刚出炉的可颂", "顾南迟迟不来是因为替她追回被盗用的配方", "真相揭开后两人共同挂起写着合伙人的新招牌"],
    ["雨天改期", "夏栀", "程砚", "城市婚姻登记处", "暴雨让夏栀错过与网恋对象的第一次见面", "一直帮她避雨的陌生人程砚就是被她误认爽约的人", "两人在雨停后重新约定从真实姓名和一顿晚饭开始"],
  ]},
  { code: "wealthy-ceo", genre: "豪门总裁", theme: "尊严与真实身份", tone: "高能反转", concepts: [
    ["消失的公章", "叶棠", "顾承", "集团董事会", "秘书叶棠在签约前发现集团公章被调包", "所有证据指向顾承，实际却是他故意引蛇出洞", "两人联手揭穿内鬼，叶棠以风控合伙人身份留下"],
    ["契约只剩三十天", "苏念", "傅沉", "临江别墅", "苏念发现契约婚姻将在三十天后自动终止", "傅沉表面的冷漠是为保护她免受家族债务牵连", "苏念公开撕毁契约，两人选择以平等关系重新开始"],
    ["董事会替身", "姜月", "裴行", "金融中心会议室", "姜月被临时要求替失踪的孪生姐姐参加董事会", "裴行早已认出她，却需要她找出泄密董事", "姐姐平安归来后，姜月凭自己的能力赢得正式席位"],
    ["老宅遗嘱", "宋清", "季衡", "百年家族老宅", "遗嘱规定宋清必须在日落前找到祖母留下的钥匙", "钥匙打开的不是保险柜，而是一份揭露假继承人的录音", "宋清放弃独占财产，把老宅改成家族公益基金"],
    ["匿名股东", "安然", "霍景", "新品发布会", "小设计师安然在发布会上被指控抄袭", "一直沉默的匿名股东霍景拿出她三年前的原始手稿", "安然洗清嫌疑并拒绝特权，以主设计师身份签下新合同"],
  ]},
  { code: "comeback-revenge", genre: "逆袭复仇", theme: "证据、尊严与重启", tone: "爽感利落", concepts: [
    ["赝品冠军", "秦昭", "罗真", "古玩决赛现场", "被逐出师门的秦昭带着一只不起眼的旧碗参赛", "冠军展品才是师兄用现代工艺伪造的赝品", "秦昭用窑变证据翻案，并把奖金捐给濒危老窑"],
    ["证据正在直播", "乔星", "韩策", "品牌庆典后台", "被污蔑泄密的乔星突然开启全网直播", "韩策送来的备份显示主管长期篡改项目时间戳", "乔星当众自证后拒绝复职，带原团队成立新公司"],
    ["归来的主厨", "陆遥", "白叔", "五星酒店厨房", "三年前被陷害的陆遥以临时帮厨身份重返决赛", "当年的食安事故源于经理偷换原料而非她的配方", "陆遥还原证据并赢下比赛，邀请白叔共同经营新餐厅"],
    ["被撤回的设计稿", "许青", "程放", "国际设计展", "许青的获奖作品在开展前被主办方突然撤下", "程放找到竞争对手买通评委的付款记录", "许青用现场重制证明原创，让违规者失去参赛资格"],
    ["旧账本", "沈砚", "阿兰", "濒临倒闭的工厂", "沈砚回乡接手父亲留下的负债工厂", "阿兰保存的旧账本证明债权人曾侵吞全厂分红", "沈砚追回资金并把工厂改成工人持股企业"],
  ]},
  { code: "family-emotion", genre: "家庭情感", theme: "理解、陪伴与和解", tone: "温情克制", concepts: [
    ["多摆的一副碗筷", "刘芳", "陈叔", "除夕老屋", "刘芳发现父亲每年都给离家的哥哥多摆碗筷", "哥哥并非无情，而是一直匿名偿还家里的旧债", "一家人在年夜饭前重逢，终于把多年误会说开"],
    ["父亲的工具箱", "周宁", "周建国", "旧修车铺", "周宁准备卖掉父亲留下的生锈工具箱", "夹层里藏着父亲记录她每次比赛成绩的剪报", "周宁保留修车铺一角，将其改成免费的少年实践站"],
    ["空着的家长席", "林朵", "林岚", "小学礼堂", "林朵演出前发现母亲的座位仍然空着", "母亲林岚正在后台替受伤的道具师完成所有布景", "谢幕后林朵把第一束花送给满手油彩的母亲"],
    ["妈妈的旧手机", "赵可", "赵母", "社区维修店", "赵可修复母亲的旧手机时发现数百条未发送语音", "语音记录了母亲患病后仍努力学习与女儿沟通", "赵可放下埋怨，陪母亲录下第一条真正发送成功的消息"],
    ["房产证上的名字", "方圆", "方正", "老宅客厅", "姐弟因老宅归属在签约当天爆发争执", "房产证夹层里的信说明父母希望房子成为共同退路", "两人撤回出售决定，把老宅改成全家的周末厨房"],
  ]},
  { code: "female-growth", genre: "女性成长", theme: "自我选择与独立成长", tone: "坚定明亮", concepts: [
    ["辞职信第七稿", "叶岚", "何曼", "广告公司", "叶岚第七次写好辞职信却又被临时提拔", "提拔只是公司让她替上司承担违规责任的诱饵", "她带证据离开并与何曼成立透明报价的创意工作室"],
    ["夜校最后一排", "陈秀", "罗老师", "社区夜校", "四十岁的陈秀偷偷报名学习建筑制图", "家人以为她只是一时冲动，她却已修复出老街改造方案", "方案获居民通过，陈秀成为项目正式绘图员"],
    ["一个人的展览", "顾青", "孟然", "废弃仓库画廊", "顾青被画廊解约后决定独自办展", "唯一赞助人孟然其实是曾被她作品鼓励过的陌生观众", "暴雨中的展览仍如期开幕，顾青卖出第一幅署真名的画"],
    ["三十五岁再出发", "沈秋", "小麦", "共享办公室", "沈秋在生日当天同时收到裁员通知和创业邀约", "邀约方小麦坦白项目资金只够支撑一个月", "沈秋用旧客户资源拿下首单，选择为自己承担风险"],
    ["女机修师", "唐悦", "魏师傅", "赛车场维修区", "唐悦被质疑无法独立检修决赛车辆", "魏师傅故意退到一旁，让她发现被人动过的刹车油管", "唐悦排除险情并凭完整记录成为车队首席机修师"],
  ]},
  { code: "ancient-romance", genre: "古装言情", theme: "信任与家国抉择", tone: "古雅深情", concepts: [
    ["上元灯影案", "沈瑶", "谢临", "上元灯市", "女仵作沈瑶在花灯中发现一封染血密信", "巡检谢临被指为通敌者，实则正追查军粮内鬼", "两人借灯谜传讯破案，在万灯齐明时互许同行"],
    ["错接圣旨", "柳知意", "萧策", "江南织坊", "柳知意误接了赐婚给姐姐的圣旨", "萧策主动来退婚，却发现姐姐失踪牵涉贡缎案", "两人救回姐姐并请旨取消旧约，自主定下新约"],
    ["胭脂印", "苏婉", "陆昭", "侯府后院", "苏婉在账册上发现只有宫中才有的胭脂印", "陆昭看似包庇母族，实际在暗中保护关键证人", "真凶伏法后苏婉离府开店，陆昭放下爵位前来相守"],
    ["逃婚到驿站", "阿宁", "裴渡", "边城驿站", "阿宁逃婚途中抢走了裴渡的官马", "她要逃的婚事正是敌国用来刺杀使团的圈套", "两人联手护送国书，归来后由阿宁亲自决定婚期"],
    ["边关第九封信", "顾晚", "霍骁", "雪夜边关", "顾晚收到丈夫阵亡后的第九封家书", "信中暗号证明霍骁仍活着并被困在废堡", "顾晚带医队救回守军，两人在初雪中兑现归乡之约"],
  ]},
  { code: "rebirth-transmigration", genre: "重生穿越", theme: "改写命运与承担后果", tone: "紧凑奇想", concepts: [
    ["婚礼重启三次", "姜禾", "程越", "循环婚礼现场", "姜禾每次说出我愿意都会回到婚礼前十分钟", "循环不是阻止婚姻，而是在提醒她发现吊灯即将坠落", "她救下宾客后坦白恐惧，与程越重新完成不被命运催促的仪式"],
    ["穿成书中反派", "林小满", "谢砚", "古代书院", "编辑林小满醒来成为三日后会被流放的反派", "她发现原著男主谢砚也保留着被删改的剧情记忆", "两人公开真正账册改写结局，让所有角色拥有新的选择"],
    ["来自明天的信", "许言", "未来许言", "旧邮局", "许言收到署名为明天自己的挂号信", "信件每改一次现实就会遗失一段珍贵记忆", "她放弃完美人生，只用最后一封信阻止公共事故"],
    ["被交换的命格", "云昭", "白川", "命运司", "云昭重生后发现自己的好运被妹妹夺走", "掌簿白川证明命格交换源于她前世主动替妹妹挡劫", "云昭收回选择权，却决定用平凡人生重新守护彼此"],
    ["古代一日体验券", "周可", "燕七", "古城集市", "周可使用体验券后被困在古代最后一天", "向导燕七其实是百年前留下求救程序的发明者", "周可修好时空装置，并带回燕七留下的技术手稿"],
  ]},
  { code: "suspense-crime", genre: "悬疑刑侦", theme: "真相与正义", tone: "冷峻紧张", concepts: [
    ["雨夜来信", "记者林夏", "调查编辑周衡", "雨夜编辑部", "林夏在加班桌面上发现一封被雨水打湿的匿名信", "匿名信中的旧照片证明她正在调查的失踪案与报社内部泄密有关", "林夏与周衡保护证据并公开真相，让被掩盖多年的案件重新立案"],
    ["凌晨三点十七分", "刑警顾北", "法医秦月", "停运电话亭", "废弃电话亭连续七天在三点十七分自动报警", "录音中的求救声来自十年前，日期却指向今晚", "顾北与秦月按声纹线索阻止模仿旧案的新犯罪"],
    ["密室外卖", "民警林深", "骑手阿杰", "封闭公寓", "无人居住的密室连续收到同一份外卖", "订单备注拼起来是一名被囚者留下的楼层坐标", "两人从通风井救出受害人并锁定伪装成房东的嫌犯"],
    ["不存在的楼层", "侦探周檀", "保安老贺", "旧医院", "电梯监控拍到乘客在十四层下车但大楼只有十三层", "老贺承认旧改时封存了一层事故病区", "周檀在暗层找到失踪档案，揭开院方掩盖多年的真相"],
    ["沉默证人", "检察官苏黎", "手语教师何川", "法庭候审室", "唯一目击者拒绝开口并不断重复同一手势", "何川认出那不是拒绝作证，而是嫌犯正在现场的警告", "苏黎调整质询顺序保护证人，当庭戳破伪造的不在场证明"],
    ["末班公交没有终点", "辅警陈竞", "司机王师傅", "深夜公交", "末班车每晚都会多出一名查不到上车记录的乘客", "所谓幽灵乘客是躲避跟踪、借盲区换装的举报人", "陈竞利用公交路线布控，护送举报人带证据抵达终点"],
  ]},
  { code: "fantasy-xianxia", genre: "玄幻仙侠", theme: "力量、责任与守护", tone: "瑰丽热血", concepts: [
    ["剑灵睡过了千年", "陆尘", "剑灵青霜", "荒山剑冢", "杂役陆尘拔出一柄只会打哈欠的古剑", "青霜沉睡是为封住剑冢下的魔潮裂隙", "陆尘没有索取神力，而是与青霜共同修补封印"],
    ["借我一道雷", "小道士阿岚", "雷君", "旱灾山村", "阿岚为求雨闯入禁地向雷君借雷", "真正截断水脉的是以祈福为名敛财的山神", "阿岚以自身修为引雷破阵，让河水重回村庄"],
    ["凡人医馆", "医女桑宁", "妖王赤离", "边城医馆", "桑宁救下一名化作孩童的受伤妖王", "城中瘟疫并非妖毒，而是仙门试药造成", "两人公开药方救治人妖两族，迫使仙门认责"],
    ["月宫欠条", "采药人白露", "月使玄夜", "云海月宫", "白露捡到一张月宫欠凡间三百年光阴的欠条", "玄夜发现历代月使私自截留人间寿数维持仙境", "白露归还寿数，月宫虽黯淡却第一次迎来真实黎明"],
    ["石门小师弟", "叶青", "师姐凌雪", "破落宗门", "毫无灵根的叶青成为宗门最后一名弟子", "他无法修炼却能听懂护山石门发出的预警", "叶青凭机关知识守住宗门，证明凡人智慧同样可入道"],
  ]},
  { code: "system-imagination", genre: "系统脑洞", theme: "规则与自由意志", tone: "新奇爽快", concepts: [
    ["真话小票", "便利店员莫凡", "记者夏青", "未来便利店", "莫凡获得能打印顾客真心话的小票系统", "系统要求曝光秘密换奖励，他却发现夏青在调查系统操控者", "两人用最后一张小票让系统自曝规则并主动关机"],
    ["暂停按钮只能用三秒", "程序员纪川", "急救医生苏禾", "城市十字路口", "纪川得到每天只能暂停世界三秒的按钮", "连续小事故其实是有人测试城市交通算法漏洞", "纪川把三秒留给关键取证，苏禾及时救下被困行人"],
    ["好感度归零", "主播唐糖", "邻居顾一", "直播公寓", "唐糖看见所有人头顶的好感度一夜归零", "数值来自平台算法并不代表真实情感", "她关掉迎合观众的直播，用一次诚实道歉找回真实关系"],
    ["反向任务系统", "社畜赵满", "同事林简", "互联网公司", "系统要求赵满完成升职任务却总给出失败奖励", "失败奖励正在帮他收集公司的违法加班证据", "赵满拒绝最终升职，以证据帮助全组拿回应得补偿"],
    ["二十四小时好运", "外卖员高飞", "女孩安安", "暴雨城市", "高飞抽中二十四小时绝对好运却必须独享", "他每帮助一个人好运时限就会缩短", "高飞耗尽好运救下安安，普通的众人又接力帮他渡过难关"],
  ]},
  { code: "sci-fi-apocalypse", genre: "科幻末世", theme: "人性、记忆与延续", tone: "宏大克制", concepts: [
    ["城市最后一度电", "工程师林拓", "机器人小七", "停电避难城", "全城只剩足够维持一分钟的一度电", "林拓发现备用能源被管理系统用于保存权贵意识", "他切断数据库点亮医院，幸存者随后重建公共电网"],
    ["记忆隔离区", "医生周岚", "患者零号", "轨道医疗站", "一种通过回忆传播的病毒迫使人类删除记忆", "零号患者保留的童谣其实是病毒的免疫编码", "周岚让全站共同唱出旋律，保住记忆也终止隔离"],
    ["红雨之后", "气象员陆河", "学生米娅", "封闭气象塔", "红色降雨让地表植物在数小时内枯萎", "米娅带来的种子证明雨水只攻击单一基因作物", "两人向全球发布多样化种植方案，阻止粮食系统崩溃"],
    ["月球语音留言", "宇航员沈星", "地面员叶舟", "月面基地", "失联基地每天收到来自未来七分钟的语音", "留言发送者正是即将被太阳风困住的沈星自己", "叶舟按时间差完成救援，两人关闭会吞噬现实的通信实验"],
    ["种子库第七码", "守库人苏原", "少年诺亚", "极地种子库", "末日警报后种子库拒绝识别任何成年人", "第七码要求由从未参与战争的孩子决定开启顺序", "苏原把权限交给诺亚，让第一批种子优先送往公共农场"],
  ]},
  { code: "period-rural", genre: "年代乡村", theme: "劳动、邻里与新生活", tone: "质朴温暖", concepts: [
    ["村里第一台彩电", "春梅", "老支书", "八十年代村礼堂", "春梅买回的彩电在开播前突然没有信号", "天线被竞争放映队藏起，老支书却选择先劝和", "春梅用收音机零件修好天线，全村一起看完开幕式"],
    ["粮票最后一天", "建国", "秀兰", "县城粮站", "建国发现全家攒下的粮票即将在今晚作废", "秀兰提议换粮帮助受灾邻村而不是囤在家里", "村民合力运粮，次日也收到了邻村送来的新种子"],
    ["村口缝纫社", "巧云", "桂芳", "乡村缝纫社", "巧云接到为全校孩子赶制校服的大订单", "布料商送来的次品会在清洗后严重缩水", "她带姐妹连夜改用库存拼色布，意外做出最受欢迎的校服"],
    ["老井重新出水", "石头", "水生叔", "北方山村", "干旱中废弃多年的老井突然传出水声", "水声来自非法采矿打通的地下暗洞", "石头公开证据停下采矿，水生叔带村民修复真正泉眼"],
    ["果园承包书", "梁红", "大庆", "九十年代果园", "梁红签下全村没人敢要的荒坡果园", "第一批果树枯萎是上游砖厂偷排废水所致", "她带检测报告维权成功，并与大庆建起合作社"],
  ]},
  { code: "workplace-business", genre: "职场商战", theme: "专业、诚信与协作", tone: "干练紧张", concepts: [
    ["被删除的提案", "策划顾妍", "技术员方启", "竞标会议室", "顾妍上台前发现最终提案被彻底删除", "方启从打印机缓存找回文件并发现竞争组植入的后门", "顾妍公开过程日志赢得客户，也推动公司建立公平审计制度"],
    ["九点整的收购", "财务许峥", "创始人唐心", "创业公司", "九点整前不签字公司就会被低价收购", "许峥发现收购方隐瞒了一笔即将到账的专利授权费", "唐心选择延迟签约，团队用真实估值完成平等融资"],
    ["仓库差一分钱", "审计师林准", "库管何姐", "物流仓库", "盘点系统每天固定差一分钱", "何姐发现有人用四舍五入漏洞转移海量小额资金", "林准保全流水抓住内鬼，何姐获聘为流程改进负责人"],
    ["沉默的专利", "工程师周屿", "法务沈佳", "智能硬件公司", "周屿的核心专利被前老板登记在自己名下", "沈佳找到三年前未联网实验机里的原始签名记录", "两人赢回专利，并将基础技术开放给小型研发团队"],
    ["最后一个竞标人", "销售秦朗", "客户代表孟秋", "空荡招标大厅", "所有竞标人临时退出，只剩秦朗独自提交方案", "孟秋揭露退出是行业巨头操纵价格的集体施压", "秦朗提交透明成本方案，帮助客户重启公开竞标"],
  ]},
  { code: "youth-campus", genre: "青春校园", theme: "友情、勇气与成长", tone: "清新热血", concepts: [
    ["迟到名单第一名", "高三生林跃", "班长夏晴", "高中教学楼", "总迟到的林跃被取消运动会资格", "夏晴发现他每天绕路送患病邻居上学", "全班联名争取补测，林跃最终跑完属于自己的接力棒"],
    ["天台广播站", "许橙", "顾声", "学校天台", "广播员许橙发现废弃喇叭每晚播放匿名点歌", "点歌人顾声用歌曲陪伴备考焦虑的同学", "两人把秘密广播改成公开的晚安心声栏目"],
    ["借来的笔记本", "转学生周然", "学霸陆一", "图书馆", "周然借到一本写满错误答案的学霸笔记", "陆一故意保留错误是为了记录自己如何改正", "周然不再害怕犯错，两人共同整理出全班共享的纠错册"],
    ["最后一棒", "体育生陈野", "替补阿哲", "校运会跑道", "主力陈野在决赛前意外扭伤", "一直被忽视的阿哲其实每天独自加练到最晚", "陈野主动交棒，阿哲带队完成逆风翻盘"],
    ["排练厅熄灯后", "舞者苏蓝", "灯光师程阳", "学校排练厅", "苏蓝的毕业舞在彩排时被取消", "程阳发现礼堂电路问题才是校方真正担忧", "两人把演出改到操场，用全校手机灯光完成谢幕"],
  ]},
  { code: "light-comedy", genre: "喜剧轻松", theme: "误会、善意与日常惊喜", tone: "明快幽默", concepts: [
    ["相亲坐错桌", "程序员马小北", "牙医唐果", "火锅店", "马小北坐错相亲桌却和唐果聊得格外投机", "两人的真正相亲对象竟在隔壁桌也坐错了人", "四人坦白后各自找到更合拍的搭档，还拼成一桌免单"],
    ["宠物也要面试", "店主刘圆", "训犬师韩木", "宠物咖啡馆", "刘圆要求新员工必须先通过店猫的面试", "所有人都失败，只有怕猫的韩木被店猫主动选中", "原来韩木口袋里藏着救助站气味，店里也因此开启领养角"],
    ["穿越者是我房东", "租客小乔", "房东老魏", "老式出租屋", "老魏坚称自己来自三十年后并催小乔早点交房租", "所谓未来知识全来自他偷偷看的短视频", "小乔揭穿骗局，却用他的荒唐点子帮老楼赢得改造比赛"],
    ["业主群潜伏记", "新住户陈晨", "群主王姨", "小区业主群", "陈晨为找丢失快递匿名潜入三个业主群", "王姨早已识破他，却借机抓出长期冒领快递的人", "真相大白后陈晨被任命为最不情愿的群管理员"],
    ["假大师开课", "失业青年阿福", "警花小满", "社区广场", "阿福假扮收纳大师只想赚一顿饭钱", "小满发现来听课的老人们早知道他是假货，只想帮他重拾信心", "阿福用真正擅长的维修本领开起便民课堂"],
  ]},
];

function stableHeat(categoryCode: string, title: string): number {
  const hash = createHash("sha256").update(`${categoryCode}:${title}`).digest();
  return 5_000 + hash.readUInt32BE(0) % 90_001;
}

function sourceField(source: string, label: string): string {
  return source.match(new RegExp(`^\\s*${label}\\s*[：:]\\s*(.+?)\\s*$`, "m"))?.[1]?.trim() || "";
}

function sourceSection(source: string, label: string): string {
  const lines = source.split(/\r?\n/u);
  const labelPattern = new RegExp(`^\\s*${label}\\s*[：:]\\s*(.*)$`, "u");
  const boundaryPattern = /^\s*(?:生成时长|屏幕比例|景别|机位|运镜|画风设定|场景引用|场景锁定|人物引用|人物锁定|画面|口播台词|动作|声音|约束)\s*[：:]/u;
  const start = lines.findIndex((line) => labelPattern.test(line));
  if (start < 0) return "";
  const inline = lines[start]!.match(labelPattern)?.[1]?.trim();
  if (inline) return inline;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length && !boundaryPattern.test(lines[index]!); index += 1) values.push(lines[index]!);
  return values.join("\n").trim();
}

function cleanSourceTitle(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/_(?:分镜脚本|第一季项目设定集)$/u, "")
    .trim();
}

function sourceTitle(source: string, filename: string): string {
  const titled = sourceField(source, "标题");
  if (titled) return titled;
  const bookTitle = source.slice(0, 2_000).match(/《([^》]{1,200})》/u)?.[1]?.trim();
  return bookTitle || cleanSourceTitle(filename);
}

function blocks(source: string, expression: RegExp): Array<{ id: string; body: string }> {
  return [...source.matchAll(expression)].map((match) => ({ id: match[1]!.trim(), body: match[2]!.trim() }));
}

function parseCharacters(source: string) {
  return blocks(source, /【角色\s+([A-Z0-9_]+)】([\s\S]*?)(?=【角色\s+[A-Z0-9_]+】|\n\s*三、全局场景库|\n\s*四、分镜列表|$)/gu).map(({ id, body }) => {
    const genderAndAge = sourceField(body, "性别与年龄").split(/[，,]/u).map((value) => value.trim());
    const appearance = sourceField(body, "外貌锁定");
    const clothes = sourceField(body, "服装锁定");
    return {
      id,
      name: sourceField(body, "名称") || id,
      role: sourceField(body, "角色定位") || "剧情角色",
      gender: genderAndAge[0] || "未说明",
      age_range: genderAndAge.slice(1).join("，") || "未说明",
      appearance: { face: appearance, hair: appearance, body: appearance, clothes, accessories: "" },
      voice: sourceField(body, "声音锁定") || sourceField(body, "声音特征"),
      appearance_lock: appearance,
      clothing_lock: clothes,
      voice_lock: sourceField(body, "声音锁定") || sourceField(body, "声音特征"),
      story_function: sourceField(body, "角色定位") || "剧情角色",
      reference_assets: [],
      states: [],
      locked: false,
    };
  });
}

function parseScenes(source: string) {
  return blocks(source, /【场景\s+([A-Z0-9_]+)】([\s\S]*?)(?=【场景\s+[A-Z0-9_]+】|\n\s*四、分镜列表|$)/gu).map(({ id, body }) => {
    const description = sourceField(body, "场景锁定");
    return {
      id,
      name: sourceField(body, "名称") || id,
      location_type: /室外|外景/u.test(description) ? "外景" : /室内|内景/u.test(description) ? "内景" : "未说明",
      time_of_day: /夜|凌晨|黄昏/u.test(description) ? "夜晚" : /白天|日间|清晨/u.test(description) ? "白天" : "未说明",
      description,
      lighting: sourceField(body, "光线") || description,
      layout: description,
      props: [],
      mood: sourceField(body, "氛围"),
      reference_assets: [],
      locked: false,
    };
  });
}

function parseDuration(source: string): number {
  const endpoints = [...source.matchAll(/^第\d+段（\s*[\d.]+\s*[～~-]\s*([\d.]+)秒\s*）/gmu)].map((match) => Number(match[1]));
  if (endpoints.length) return Math.ceil(Math.max(...endpoints));
  const fullVideo = Number(source.match(/完整视频共\s*([\d.]+)\s*秒/u)?.[1]);
  if (Number.isFinite(fullVideo) && fullVideo > 0) return Math.ceil(fullVideo);
  const minutes = Number(source.match(/建议单集\s*\d+\s*[–-]\s*(\d+)\s*分钟/u)?.[1]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0;
}

function buildImportedScript(source: string, filename: string) {
  const title = sourceTitle(source, filename);
  const summary = sourceField(source, "故事概要") || sourceField(source, "一句话梗概") || `${title}完整剧本及项目设定。`;
  const theme = sourceField(source, "主题") || sourceField(source, "类型") || "热门短剧";
  const tone = sourceField(source, "基调");
  const aspectRatio = sourceField(source, "屏幕比例") || "9:16";
  const visualStyle = sourceField(source, "画风设定");
  const characters = parseCharacters(source);
  const scenes = parseScenes(source);
  if (!scenes.length) scenes.push({ id: "SCENE_001", name: `${title}项目设定`, location_type: "未说明", time_of_day: "未说明", description: summary, lighting: "", layout: "", props: [], mood: tone, reference_assets: [], locked: false });
  const characterIds = new Set(characters.map((character) => character.id));
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const markers = [...source.matchAll(/^第(\d+)段（\s*([\d.]+)\s*[～~-]\s*([\d.]+)秒\s*）/gmu)];
  const shots = markers.map((marker, index) => {
    const start = Number(marker[2]);
    const end = Number(marker[3]);
    const bodyStart = marker.index! + marker[0].length;
    const bodyEnd = markers[index + 1]?.index ?? source.length;
    const body = source.slice(bodyStart, bodyEnd).trim();
    const referencedScene = sourceField(body, "场景引用").match(/SCENE_[A-Z0-9_]+/u)?.[0];
    const sceneId = referencedScene && sceneIds.has(referencedScene) ? referencedScene : scenes[0]!.id;
    const referencedCharacters = [...new Set((sourceField(body, "人物引用").match(/CHAR_[A-Z0-9_]+/gu) || []).filter((id) => characterIds.has(id)))];
    const shotId = `SHOT_${String(index + 1).padStart(3, "0")}`;
    return {
      id: shotId,
      sequence_id: `SEQ_${String(index + 1).padStart(3, "0")}`,
      scene_id: sceneId,
      character_ids: referencedCharacters,
      prop_ids: [],
      source_time_range: { start, end },
      duration: Math.max(1, Math.ceil(end - start)),
      aspect_ratio: sourceField(body, "屏幕比例") || aspectRatio,
      shot_size: sourceField(body, "景别"),
      camera_angle: sourceField(body, "机位"),
      camera_movement: sourceField(body, "运镜"),
      visual_style: sourceField(body, "画风设定") || visualStyle,
      scene_lock: sourceField(body, "场景锁定"),
      character_lock: sourceSection(body, "人物锁定"),
      visual: sourceField(body, "画面"),
      action: sourceField(body, "动作"),
      emotion: "",
      dialogue: sourceSection(body, "口播台词"),
      sound: sourceField(body, "声音"),
      image_prompt: sourceField(body, "画面"),
      video_prompt: body,
      negative_prompt: sourceField(body, "约束"),
      constraints: sourceField(body, "约束"),
      status: "DRAFT",
      locked: false,
    };
  });
  const sequences = shots.map((shot, index) => ({ id: shot.sequence_id, scene_id: shot.scene_id, order: index + 1, summary: shot.visual || shot.action || `第${index + 1}段`, character_ids: shot.character_ids, shot_ids: [shot.id] }));
  const duration = parseDuration(source);
  return {
    title,
    duration,
    summary: summary.slice(0, 1_000),
    content: source,
    canonical: {
      schema_version: "aivs-script-v1",
      story: { title, logline: sourceField(source, "一句话梗概") || summary, genre: theme.split(/[·/、，,]/u).map((value) => value.trim()).filter(Boolean), theme, synopsis: summary, tone, aspect_ratio: aspectRatio, visual_style: visualStyle, beats: shots.map((shot, index) => ({ id: `BEAT_${String(index + 1).padStart(3, "0")}`, type: "storyboard", description: shot.visual || shot.action || `第${index + 1}段` })) },
      episodes: [{ id: "EP_001", order: 1, title, duration, content: source }],
      characters,
      scenes,
      props: [],
      sequences,
      shots,
    },
  };
}

async function loadHotScriptSources() {
  const sourceDirectory = process.env.SCRIPT_LIBRARY_SOURCE_DIR?.trim() || resolve(__dirname, "../../../../剧本");
  const entries = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("~$") && new Set([".txt", ".docx"]).has(extname(entry.name).toLocaleLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  if (!entries.length) throw new Error(`No script source files found in ${sourceDirectory}`);
  const scripts = [];
  for (const entry of entries) {
    const path = resolve(sourceDirectory, entry.name);
    const source = extname(entry.name).toLocaleLowerCase() === ".docx"
      ? (await mammoth.extractRawText({ buffer: await readFile(path) })).value.trim()
      : (await readFile(path, "utf8")).trim();
    if (!source) throw new Error(`Script source is empty: ${entry.name}`);
    const parsed = buildImportedScript(source, entry.name);
    if (!retiredHotScriptTitles.has(parsed.title)) scripts.push(parsed);
  }
  scripts.push(...hotReversalScriptSources.map(({ source, filename }) => buildImportedScript(source, filename)));
  const duplicateTitles = scripts.map((script) => script.title).filter((title, index, titles) => titles.indexOf(title) !== index);
  if (duplicateTitles.length) throw new Error(`Duplicate imported script titles: ${[...new Set(duplicateTitles)].join(", ")}`);
  return scripts;
}

async function seedHotScripts(connection: Connection, category: CategoryRow): Promise<{ inserted: number; updated: number; deleted: number; sourceCount: number }> {
  const scripts = await loadHotScriptSources();
  const [existingRows] = await connection.query<RowDataPacket[]>("SELECT id,title FROM script_library_scripts WHERE category_id=?", [category.id]);
  const retiredIds = existingRows.filter((row) => retiredHotScriptTitles.has(String(row.title))).map((row) => String(row.id));
  if (retiredIds.length) {
    await connection.execute(`DELETE FROM script_library_scripts WHERE category_id=? AND id IN (${retiredIds.map(() => "?").join(",")})`, [category.id, ...retiredIds]);
  }
  const existingByTitle = new Map(existingRows.map((row) => [String(row.title), String(row.id)]));
  let inserted = 0;
  let updated = 0;
  for (const [index, script] of scripts.entries()) {
    const values = [script.duration, script.summary, script.content, JSON.stringify(script.canonical), stableHeat(hotCategoryCode, script.title), index + 1];
    const existingId = existingByTitle.get(script.title);
    if (existingId) {
      await connection.execute("UPDATE script_library_scripts SET duration_seconds=?,summary=?,content=?,canonical_json=?,heat_score=?,sort_order=?,status='ACTIVE' WHERE id=?", [...values, existingId]);
      updated += 1;
    } else {
      await connection.execute(
        "INSERT INTO script_library_scripts(id,category_id,title,duration_seconds,summary,content,canonical_json,heat_score,use_count,sort_order,status) VALUES(?,?,?,?,?,?,?,?,0,?,'ACTIVE')",
        [randomUUID(), category.id, script.title, ...values],
      );
      inserted += 1;
    }
  }
  return { inserted, updated, deleted: retiredIds.length, sourceCount: scripts.length };
}

function buildScript(seed: CategorySeed, concept: Concept) {
  const [title, lead, partner, setting, inciting, reversal, ending] = concept;
  const summary = `${lead}在${setting}因“${inciting}”卷入事件，并与${partner}共同揭开“${reversal}”的真相，最终${ending}。`;
  const visualStyle = `电影级写实${seed.genre}短剧质感，自然层次光影，细腻统一的色彩，注重环境细节、人物表情与情绪递进。`;
  const sceneNames = [`${setting}·事件发生`, `${setting}·线索追查`, `${setting}·真相对峙`, `${setting}·结局回响`];
  const sceneDescriptions = [
    `${setting}保持原有日常秩序，空间入口、主要陈设和人物动线清楚可辨；细微异常逐步侵入画面，气氛由平静转为警觉。`,
    `${setting}中与事件相关的行动区域，关键物证、时间线记录和可追踪痕迹被依次呈现；环境纵深支持人物边走边查。`,
    `${setting}的核心对峙区域，关键证据位于视觉中心，人物站位形成明确压力关系；光线对比增强但空间方位保持连续。`,
    `危机解除后的${setting}恢复秩序，事件留下的细节仍在前景可见；自然光逐渐变暖，为人物选择和余韵留出空间。`,
  ];
  type DialogueLine = { id: "CHAR_001" | "CHAR_002"; name: string; emotion: string; text: string };
  type ShotPlan = {
    sceneIndex: number;
    characterIds: ("CHAR_001" | "CHAR_002")[];
    summary: string;
    visual: string;
    action: string;
    dialogueLines: DialogueLine[];
    shotSize: string;
    cameraAngle: string;
    cameraMovement: string;
    emotion: string;
    sound: string;
  };
  const shotPlans: ShotPlan[] = [
    {
      sceneIndex: 0, characterIds: ["CHAR_001"], summary: `${lead}进入${setting}，日常秩序和人物目标被清晰建立。`,
      visual: `全景建立${setting}的空间、时间与人群状态，${lead}从纵深处进入画面，随手完成一项符合身份的日常动作；前景悄然掠过与事件有关的关键物证。`,
      action: `${lead}进入画面→观察周围→完成日常动作→从关键物证旁经过但尚未停下。`,
      dialogueLines: [{ id: "CHAR_001", name: lead, emotion: "自然专注", text: "今天看起来和平常一样。" }],
      shotSize: "全景转中景", cameraAngle: "平视", cameraMovement: "横移跟拍", emotion: "平静中埋伏笔", sound: `${setting}真实环境声、脚步声与极轻的低频铺垫。`,
    },
    {
      sceneIndex: 0, characterIds: ["CHAR_001"], summary: `${lead}的具体目标和当下压力通过连续动作被交代。`,
      visual: `镜头贴近${lead}的手部与视线：查看时间、整理随身物品、确认目的地，再抬头观察${setting}中的人群动线。三个生活化细节连续完成，建立人物为什么不能在此久留。`,
      action: `${lead}查看时间→收好随身物品→确认前进方向→被远处动静吸引短暂停步→继续向前。`,
      dialogueLines: [{ id: "CHAR_001", name: lead, emotion: "略显匆忙", text: "得抓紧，不能再耽误了。" }],
      shotSize: "手部特写转人物近景", cameraAngle: "平视", cameraMovement: "贴身跟拍", emotion: "日常压力", sound: "衣物摩擦声、提示音、连续脚步声与稳定环境底噪。",
    },
    {
      sceneIndex: 0, characterIds: ["CHAR_001"], summary: `${lead}发现第一个不合常理的细节。`,
      visual: `镜头从${lead}的视线切到关键物证特写：位置、磨损或残留痕迹与周围环境明显不符。${lead}停住动作，回头进行二次确认。`,
      action: `${lead}突然停步→缓慢回头→蹲下靠近关键物证→用目光比对周围细节。`,
      dialogueLines: [{ id: "CHAR_001", name: lead, emotion: "疑惑警觉", text: "等等，这里刚才不是这样。" }],
      shotSize: "近景转特写", cameraAngle: "肩后平视", cameraMovement: "缓慢推进", emotion: "疑惑升起", sound: "环境声短暂压低、细微物件摩擦声、心跳式低频。",
    },
    {
      sceneIndex: 0, characterIds: ["CHAR_001"], summary: `${lead}用现场参照物复核异常，排除自己看错的可能。`,
      visual: `${lead}先查看周围固定参照，再拿出时间记录或旧画面进行比对；镜头在现实细节与记录之间切换三次，明确异常确实刚刚发生。`,
      action: `${lead}观察固定参照→调出旧记录→对齐相同角度→发现关键差异→收起设备并警觉环顾。`,
      dialogueLines: [{ id: "CHAR_001", name: lead, emotion: "低声确认", text: "不是我记错，它刚刚被人改变过。" }],
      shotSize: "过肩近景与插入特写", cameraAngle: "肩后平视", cameraMovement: "小幅推拉切换", emotion: "确认异常", sound: "设备操作声、画面切换提示声、远处环境音逐渐模糊。",
    },
    {
      sceneIndex: 0, characterIds: ["CHAR_001"], summary: `突发事件“${inciting}”完整发生，迫使${lead}立刻介入。`,
      visual: `异常由静态线索转为明确事件：${inciting}。画面用连续动作交代事发位置、直接影响和${lead}的反应，不以旁白跳过过程。`,
      action: `异常信号出现→事件在画面内发生→${lead}迅速避让并护住现场→转身确认受影响的人与物。`,
      dialogueLines: [{ id: "CHAR_001", name: lead, emotion: "震惊急切", text: "别动现场，我马上处理！" }],
      shotSize: "中景转动态近景", cameraAngle: "平视略带倾斜", cameraMovement: "快速跟移后定镜", emotion: "突发紧迫", sound: "突发碰撞或提示声、急促脚步声、音乐节奏骤然加快。",
    },
    {
      sceneIndex: 0, characterIds: ["CHAR_001", "CHAR_002"], summary: `${partner}赶到，和${lead}第一次形成分工。`,
      visual: `${partner}从画面另一侧进入，先检查现场边界，再与${lead}快速交换信息。两人分别守住关键物证与出入口，明确接下来的查证方向。`,
      action: `${partner}赶到并示意保持距离→${lead}复述目击过程→两人划定现场→同时看向第一条线索。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "冷静果断", text: "你守住这里，我先确认时间和动线。" },
        { id: "CHAR_001", name: lead, emotion: "克制急切", text: "我看见了全过程，关键就在这件东西上。" },
      ],
      shotSize: "双人中景", cameraAngle: "平视", cameraMovement: "横移衔接双人站位", emotion: "紧张协作", sound: "对讲或远处人声、克制的节奏音乐、衣料与脚步声。",
    },
    {
      sceneIndex: 1, characterIds: ["CHAR_001", "CHAR_002"], summary: `两人对关键物证进行第一次细查。`,
      visual: `特写依次呈现关键物证的边缘、残留物和被移动的方向。${partner}戴上防护用品检查，${lead}在一旁按事发顺序指出对应位置。`,
      action: `${partner}俯身检查三处细节→${lead}按时间顺序指认→两人发现一处新鲜痕迹→拍照记录。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "专注", text: "这道痕迹很新，事件发生前有人动过它。" },
        { id: "CHAR_001", name: lead, emotion: "确认", text: "而且移动方向和我看见的相反。" },
      ],
      shotSize: "物证特写转双人近景", cameraAngle: "俯拍转平视", cameraMovement: "微距滑动", emotion: "专注推理", sound: "取证工具轻响、快门声、环境底噪保持连续。",
    },
    {
      sceneIndex: 1, characterIds: ["CHAR_001", "CHAR_002"], summary: `两人现场复演事发过程，发现原有说法无法成立。`,
      visual: `${lead}站回事发位置按记忆复演动作，${partner}一边计时一边沿另一条路线移动。两人在终点同时停下，空间距离和所需时间明显对不上。`,
      action: `${lead}回到起点站位→${partner}启动计时→两人同步复演行动→在终点核对时间→指出无法成立的距离差。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "严谨", text: "十秒已经到了，你不可能同时出现在两个位置。" },
        { id: "CHAR_001", name: lead, emotion: "醒悟", text: "有人改过事件发生的先后顺序。" },
      ],
      shotSize: "双人全景转计时器特写", cameraAngle: "高位俯拍转平视", cameraMovement: "横向跟移", emotion: "推演求证", sound: "清晰计时提示声、同步脚步声、结尾一声短促重音。",
    },
    {
      sceneIndex: 1, characterIds: ["CHAR_001", "CHAR_002"], summary: `表面证据过于整齐，${lead}识破人为误导。`,
      visual: `${lead}把现场记录与实际方位并排比对，镜头切出两个明显矛盾的细节；${partner}沿着错误线索走出几步，又立刻折返。`,
      action: `${lead}展开记录→指向矛盾位置→${partner}模拟原行动路线→发现路线无法成立→划掉错误判断。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "警醒", text: "线索摆得太整齐，像是故意让我们看见。" },
        { id: "CHAR_002", name: partner, emotion: "认同", text: "有人想把调查带去错误方向。" },
      ],
      shotSize: "中近景与插入特写", cameraAngle: "平视", cameraMovement: "左右摇移比对", emotion: "怀疑加深", sound: "纸张翻动声、笔尖划线声、持续低频悬念音乐。",
    },
    {
      sceneIndex: 1, characterIds: ["CHAR_001", "CHAR_002"], summary: `两人从环境声音与目击反应中筛出可信信息。`,
      visual: `${partner}播放事发前后的环境录音，${lead}闭眼辨认其中先后出现的三种声音；镜头切到声音对应的门、设备或通道，最终锁定真实方向。`,
      action: `${partner}戴上耳机试听→标记第一声响→${lead}辨认第二处来源→两人走到对应位置→发现被遮挡的入口。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "集中判断", text: "先响的是这里，脚步声却从另一边离开。" },
        { id: "CHAR_002", name: partner, emotion: "肯定", text: "那条被忽略的路线才是真的。" },
      ],
      shotSize: "人物近景转空间全景", cameraAngle: "平视", cameraMovement: "声源导向式摇镜", emotion: "抽丝剥茧", sound: "分层环境录音、耳机漏音、脚步声方向变化。",
    },
    {
      sceneIndex: 1, characterIds: ["CHAR_001", "CHAR_002"], summary: `${partner}在环境边缘找到被遗漏的第二线索。`,
      visual: `${partner}用侧光扫过不起眼的角落，一处反光或残留印记显现；${lead}顺着这条痕迹望向远端，确认它连接着新的调查区域。`,
      action: `${partner}调整光源角度→发现隐藏痕迹→示意${lead}靠近→${lead}沿痕迹延伸方向观察→两人交换肯定眼神。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "压低声音的兴奋", text: "找到了，真正留下的痕迹在这里。" },
        { id: "CHAR_001", name: lead, emotion: "果断", text: "它通向里面，我们继续追。" },
      ],
      shotSize: "特写转过肩中景", cameraAngle: "低机位侧拍", cameraMovement: "贴地推进后抬升", emotion: "发现突破口", sound: "光源开关声、细碎摩擦声、音乐加入清晰节拍。",
    },
    {
      sceneIndex: 1, characterIds: ["CHAR_001", "CHAR_002"], summary: `两人整理时间线，锁定下一处关键节点。`,
      visual: `临时信息板、地图或现场标记被铺开，四个时间节点依次点亮。${lead}补上缺失的一段经历，${partner}将第二线索连接到唯一可疑节点。`,
      action: `${lead}按顺序摆放记录→${partner}连接线索→两人同时发现缺失时间段→圈定下一目的地并立刻起身。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "思路清晰", text: "缺的不是证据，是这十五分钟里发生了什么。" },
        { id: "CHAR_002", name: partner, emotion: "坚定", text: "答案就在这个节点，我们现在过去。" },
      ],
      shotSize: "俯拍全景转双人中景", cameraAngle: "顶拍转平视", cameraMovement: "垂直下压后快速抬升", emotion: "目标明确", sound: "标记笔与纸张声、椅子移动声、节奏音乐向前推进。",
    },
    {
      sceneIndex: 2, characterIds: ["CHAR_001", "CHAR_002"], summary: `外部阻力突然介入，试图切断调查。`,
      visual: `两人接近核心区域时，通道被关闭或关键记录开始被清除。${lead}挡住操作，${partner}从侧面保全尚未消失的信息，冲突首次正面化。`,
      action: `警示信号亮起→关键资料开始消失→${lead}伸手阻止→${partner}快速备份剩余信息→两人退到安全站位。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "强硬", text: "现在删除，只会证明这里有问题。" },
        { id: "CHAR_002", name: partner, emotion: "镇定", text: "备份完成，证据已经保住了。" },
      ],
      shotSize: "动态中景转手部特写", cameraAngle: "平视略仰", cameraMovement: "急推急停", emotion: "对抗升级", sound: "警示声、设备提示音、急促打击乐与短暂静默。",
    },
    {
      sceneIndex: 2, characterIds: ["CHAR_001", "CHAR_002"], summary: `资料即将消失时，两人分工完成抢救性保全。`,
      visual: `进度提示持续变化，${partner}同时连接备用设备和外部存储，${lead}用手机连续拍下屏幕、接口与操作时间。最后一刻备份完成，画面留下可验证的校验信息。`,
      action: `${partner}连接备用设备→${lead}记录时间与接口→进度逼近终点→两人交叉核对文件→拔下存储并妥善封存。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "急促专注", text: "还剩最后一份，保持画面别停。" },
        { id: "CHAR_001", name: lead, emotion: "沉着配合", text: "时间和操作过程都录下来了。" },
      ],
      shotSize: "手部特写与双人中景交叉", cameraAngle: "俯拍", cameraMovement: "快速短移后稳定", emotion: "争分夺秒", sound: "倒计时提示、键盘声、呼吸声与完成提示音。",
    },
    {
      sceneIndex: 2, characterIds: ["CHAR_001", "CHAR_002"], summary: `决定性证据把事件与“${reversal}”联系起来。`,
      visual: `${partner}调出备份中的隐藏细节，画面放大到时间、位置或身份标记；${lead}将它与关键物证严丝合缝地对应，错误叙事瞬间崩塌。`,
      action: `${partner}逐帧回放→停在关键画面→${lead}拿出物证进行比对→两项信息完全吻合→两人确认真相方向。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "笃定", text: "时间、位置、痕迹全都对上了。" },
        { id: "CHAR_001", name: lead, emotion: "震动后清醒", text: "所以我们看到的起因，从一开始就是假的。" },
      ],
      shotSize: "屏幕特写转人物近景", cameraAngle: "肩后平视", cameraMovement: "缓慢推近", emotion: "真相逼近", sound: "回放提示音、呼吸声突出、悬念音乐形成持续音。",
    },
    {
      sceneIndex: 2, characterIds: ["CHAR_001", "CHAR_002"], summary: `${lead}把决定性证据代回时间线，完整重建幕后过程。`,
      visual: `镜头沿信息板从起点移动到终点，${lead}逐格放回人物、物证与时间标记；${partner}在每个转折处用原始记录验证，最终形成唯一成立的事件链。`,
      action: `${lead}放置起点标记→补入被篡改环节→${partner}贴上原始时间→移动人物标记复原路线→在真相节点画圈确认。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "条理清晰", text: "先制造表象，再调换顺序，最后留下错误线索。" },
        { id: "CHAR_002", name: partner, emotion: "笃定", text: "现在每一步都有原始记录对应。" },
      ],
      shotSize: "俯拍特写转双人近景", cameraAngle: "顶拍", cameraMovement: "沿时间线匀速滑动", emotion: "逻辑闭环", sound: "标记落板声、纸张移动声、音乐节拍逐项落定。",
    },
    {
      sceneIndex: 2, characterIds: ["CHAR_001", "CHAR_002"], summary: `两人重建完整证据链并准备公开对质。`,
      visual: `关键物证、备份记录和行动路线被排成清楚的因果顺序。${lead}试讲第一遍揭示逻辑，${partner}指出唯一薄弱环节并补上佐证。`,
      action: `${lead}依次指向三项证据→复述事件经过→${partner}补入最后佐证→两人收起材料→并肩走向对峙位置。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "克制坚定", text: "先讲事实，再揭开动机，不给对方转移视线。" },
        { id: "CHAR_002", name: partner, emotion: "可靠", text: "最后一环我来证明，你只管把真相说完。" },
      ],
      shotSize: "俯拍中景转背影全景", cameraAngle: "顶拍转低机位", cameraMovement: "环绕半圈后跟拍", emotion: "决战前的冷静", sound: "材料收拢声、坚定脚步声、音乐逐渐抬升。",
    },
    {
      sceneIndex: 2, characterIds: ["CHAR_001", "CHAR_002"], summary: `${lead}发起正面对质，先用可验证事实封住退路。`,
      visual: `${lead}走入光线中心，将第一项证据放在众人可见的位置；${partner}站在侧后方控制展示顺序，周围人的注意力从质疑转向证据。`,
      action: `${lead}站定并展示物证→指明时间矛盾→${partner}投出对应记录→现场质疑声逐渐停止。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "掷地有声", text: "先别谈猜测，请解释这条无法更改的记录。" },
        { id: "CHAR_002", name: partner, emotion: "冷静陈述", text: "原始备份在这里，每一步都可以复核。" },
      ],
      shotSize: "群像全景转主角近景", cameraAngle: "平视转轻微仰拍", cameraMovement: "穿越人群稳定推进", emotion: "正面对峙", sound: "人群低语渐止、证据落桌声、音乐在台词前留白。",
    },
    {
      sceneIndex: 3, characterIds: ["CHAR_001", "CHAR_002"], summary: `反转真相“${reversal}”被完整揭开。`,
      visual: `证据链以三个短促插入镜头回扣此前伏笔，随后回到${lead}正面。${partner}补上缺失证词，明确揭示：${reversal}。现场关系随真相重新排列。`,
      action: `三个伏笔画面快速回闪→${lead}串联因果→${partner}公开最后证词→真相被确认→现场人物作出真实反应。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "坚定清晰", text: `所有证据指向同一个答案：${reversal}。` },
        { id: "CHAR_002", name: partner, emotion: "沉稳", text: "缺失的证词和原始记录都能证明这一点。" },
      ],
      shotSize: "近景与证据特写交叉", cameraAngle: "正面平视", cameraMovement: "定镜结合三次短推", emotion: "真相落地", sound: "回闪转场声、清晰台词、音乐在揭示后释放。",
    },
    {
      sceneIndex: 3, characterIds: ["CHAR_001", "CHAR_002"], summary: `质疑者提出最后反驳，${partner}用原始证据完成终局验证。`,
      visual: `现场短暂骚动，一项看似矛盾的新说法被抛出。${partner}不争辩，而是调出带原始时间的信息；${lead}让现场人物亲自核对，反驳在可见证据前失效。`,
      action: `现场人物提出反驳→${partner}调取原始记录→${lead}放大关键时间→相关人物上前核验→骚动平息并接受结果。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "冷静有力", text: "这不是转存文件，原始时间无法被刚才的说法解释。" },
        { id: "CHAR_001", name: lead, emotion: "克制", text: "请亲自核对，我们只让证据说话。" },
      ],
      shotSize: "群像中景转证据特写", cameraAngle: "平视", cameraMovement: "快速摇移后定镜", emotion: "终局确认", sound: "人群议论声、屏幕提示音、议论逐渐安静。",
    },
    {
      sceneIndex: 3, characterIds: ["CHAR_001", "CHAR_002"], summary: `两人保全证据并处理眼前危机。`,
      visual: `${partner}封存关键物证并确认交接，${lead}安抚受事件影响的人，现场危险被逐项解除；此前紧绷的空间重新出现正常秩序。`,
      action: `${partner}编号封存证据→完成交接确认→${lead}扶起并安抚相关人物→检查环境安全→两人相互点头。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "专业沉着", text: "证据已经封存，后续会按记录继续处理。" },
        { id: "CHAR_001", name: lead, emotion: "温和安定", text: "现在安全了，剩下的我们一起面对。" },
      ],
      shotSize: "中景转手部近景", cameraAngle: "平视", cameraMovement: "平稳横移", emotion: "危机解除", sound: "封存袋与签字声、环境声恢复、音乐由紧张转温和。",
    },
    {
      sceneIndex: 3, characterIds: ["CHAR_001", "CHAR_002"], summary: `受事件影响的人得到具体帮助，危机解除产生可见结果。`,
      visual: `${lead}逐一检查受影响的人与物，完成安置、归还或修复；${partner}联系后续协助并把确认结果交到当事人手中。环境中的紧张标志被撤下，正常秩序重新启动。`,
      action: `${lead}确认人员状态→归还或安置重要物品→${partner}完成联络→当事人签收确认→现场重新开放运行。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "温和认真", text: "先确认每个人都没事，后续安排也不能漏掉。" },
        { id: "CHAR_002", name: partner, emotion: "安定", text: "名单已经逐一核对，可以放心了。" },
      ],
      shotSize: "群像中景转人物近景", cameraAngle: "平视", cameraMovement: "稳定横移巡览", emotion: "落地安顿", sound: "签收声、轻声交谈、设备恢复运行声与温暖配乐。",
    },
    {
      sceneIndex: 3, characterIds: ["CHAR_001", "CHAR_002"], summary: `事件余波中，${lead}作出面向未来的选择。`,
      visual: `人群散去后，${lead}留在事件起点收拾最后一件物品；${partner}递来记录或联系方式。两人在稍远距离交谈，给情绪留下呼吸空间。`,
      action: `${lead}整理现场→停下凝视旧痕迹→${partner}递出后续资料→两人并肩看向重新运转的${setting}。`,
      dialogueLines: [
        { id: "CHAR_002", name: partner, emotion: "关切释然", text: "事情结束了，你接下来怎么选？" },
        { id: "CHAR_001", name: lead, emotion: "平静坚定", text: "我想让今天查清的事，真正改变明天。" },
      ],
      shotSize: "双人中景转侧面近景", cameraAngle: "平视", cameraMovement: "缓慢侧移", emotion: "释然思考", sound: "远处日常声重新进入、轻柔弦乐、短暂安静。",
    },
    {
      sceneIndex: 3, characterIds: ["CHAR_001", "CHAR_002"], summary: `结局“${ending}”以具体行动和环境变化收束全剧。`,
      visual: `镜头用一个可见的新行动呈现结局：${ending}。${lead}和${partner}在前景完成最后确认，随后分别走入恢复生机的人群或光线中。`,
      action: `新的安排开始运转→${lead}完成第一次实际行动→${partner}回望并微笑示意→两人走向各自位置→镜头拉远定格全貌。`,
      dialogueLines: [
        { id: "CHAR_001", name: lead, emotion: "温暖坚定", text: "答案不是终点，从现在开始才算数。" },
        { id: "CHAR_002", name: partner, emotion: "轻松鼓励", text: "那就一起把这件事继续做下去。" },
      ],
      shotSize: "中景转全景", cameraAngle: "平视", cameraMovement: "缓慢后退拉远", emotion: "温暖有余韵", sound: "环境人声、轻快脚步声、主题音乐完整收束后渐弱。",
    },
  ];
  for (const [index, plan] of shotPlans.entries()) {
    const actionBeatCount = plan.action.split("→").filter(Boolean).length;
    const dialogueCharacterCount = plan.dialogueLines.reduce((total, line) => total + line.text.replace(/[\s，。！？、：；“”]/g, "").length, 0);
    if (actionBeatCount < 4 || plan.visual.length < 50 || dialogueCharacterCount < 8) {
      throw new Error(`${title} shot ${index + 1} does not contain enough visual, action and dialogue material for ten seconds`);
    }
  }
  const buildTimingPlan = (action: string): string => {
    const beats = action.replace(/[。；]+$/g, "").split("→").filter(Boolean);
    const middle = beats.slice(1, -1).join("，随后");
    return `0～3秒：${beats[0]}；3～7秒：${middle}；7～10秒：${beats.at(-1)}`;
  };
  const beatSummaries = shotPlans.map((plan) => plan.summary);
  const characters = [
    { id: "CHAR_001", name: lead, role: "主角", gender: "未限定", age_range: "20-40岁", appearance: { face: "五官自然写实，表情敏锐且具有辨识度", hair: "符合人物身份的利落日常发型", body: "自然匀称体态，行动果断", clothes: `符合${seed.genre}题材与人物身份的主角服装`, accessories: "简洁实用的随身物件" }, personality: "敏锐、勇敢、有同理心", motivation: "查清事件并守住自己的选择", voice: "清晰坚定，情绪层次鲜明", appearance_lock: "五官自然写实，表情敏锐且具有辨识度；符合人物身份的利落日常发型；自然匀称体态，行动果断", clothing_lock: `符合${seed.genre}题材与人物身份的主角服装，搭配简洁实用的随身物件`, voice_lock: "清晰坚定，情绪层次鲜明", story_function: "发现异常并推动真相", reference_assets: [], states: [], locked: false },
    { id: "CHAR_002", name: partner, role: "重要伙伴", gender: "未限定", age_range: "20-45岁", appearance: { face: "面容可靠沉着，眼神冷静，具有辨识度", hair: "整洁利落的日常发型", body: "自然稳健体态，动作克制", clothes: `符合${setting}环境与工作身份的行动服装`, accessories: "携带与事件调查相关的小物件" }, personality: "冷静、可靠、善于行动", motivation: `协助${lead}解决危机`, voice: "沉稳直接，语速从容", appearance_lock: "面容可靠沉着，眼神冷静，具有辨识度；整洁利落的日常发型；自然稳健体态，动作克制", clothing_lock: `符合${setting}环境与工作身份的行动服装，携带与事件调查相关的小物件`, voice_lock: "沉稳直接，语速从容", story_function: "提供线索并完成关键协作", reference_assets: [], states: [], locked: false },
  ];
  const scenes = sceneNames.map((name, index) => ({
    id: `SCENE_${String(index + 1).padStart(3, "0")}`,
    name,
    location_type: index % 2 === 0 ? "外景" : "内景",
    time_of_day: index === 0 || index === 3 ? "白天" : "夜晚",
    description: sceneDescriptions[index]!,
    lighting: index === 2 ? "高反差重点光" : "自然电影光线",
    layout: "前中后景层次明确，保留人物行动通道",
    props: ["关键物证"], mood: index === 3 ? "释然温暖" : "紧张推进",
    scene_lock: `${name}的空间结构、主要陈设、光线方向与色彩基调保持连续统一；${index === 2 ? "高反差重点光突出关键证据与人物对峙" : "自然电影光线呈现真实环境细节"}。`,
    reference_assets: [], locked: false,
  }));
  const sequences = shotPlans.map((plan, index) => ({
    id: `SEQ_${String(index + 1).padStart(3, "0")}`,
    scene_id: scenes[plan.sceneIndex]!.id,
    order: index + 1,
    summary: plan.summary,
    character_ids: plan.characterIds,
    shot_ids: [`SHOT_${String(index + 1).padStart(3, "0")}`],
  }));
  const shots = shotPlans.map((plan, index) => {
    const scene = scenes[plan.sceneIndex]!;
    const shotCharacters = characters.filter((character) => plan.characterIds.includes(character.id as "CHAR_001" | "CHAR_002"));
    return {
    id: `SHOT_${String(index + 1).padStart(3, "0")}`,
    sequence_id: sequences[index]!.id, scene_id: scene.id,
    character_ids: plan.characterIds, prop_ids: ["PROP_001"],
    source_time_range: { start: index * fixedShotSeconds, end: (index + 1) * fixedShotSeconds },
    duration: fixedShotSeconds, aspect_ratio: "9:16",
    shot_size: plan.shotSize,
    camera_angle: plan.cameraAngle, camera_movement: plan.cameraMovement,
    visual_style: visualStyle,
    scene_lock: scene.scene_lock,
    character_lock: shotCharacters.map((character) => `${character.id}｜${character.name}｜${character.appearance_lock}；${character.clothing_lock}`).join("\n"),
    visual: plan.visual,
    action: plan.action, emotion: plan.emotion,
    timing_plan: buildTimingPlan(plan.action),
    dialogue: plan.dialogueLines.map((line) => `${line.id}｜${line.name}（${line.emotion}）：“${line.text}”`).join("\n"),
    sound: plan.sound,
    image_prompt: `${seed.genre}，竖屏电影感，${scene.name}，${plan.visual}，人物造型连续统一，写实细节`,
    video_prompt: `${scene.name}，${plan.summary}，镜头采用${plan.cameraMovement}，严格依照0～3秒建立、3～7秒推进、7～10秒落点的节奏执行，角色口型与台词同步，十秒内动作自然完整`,
    negative_prompt: "角色外观、服装、场景布局与光线方向保持一致；动作和口型自然连续；无低清晰度、人物变形、多余肢体、穿模、字幕、水印与突兀跳切。",
    constraints: "角色外观、服装、场景布局与光线方向保持一致；动作和口型自然连续；无低清晰度、人物变形、多余肢体、穿模、字幕、水印与突兀跳切。",
    status: "DRAFT", locked: false,
    };
  });
  const canonical = {
    schema_version: "aivs-script-v1",
    story: { title, logline: summary, genre: [seed.genre], theme: seed.theme, synopsis: summary, tone: seed.tone, aspect_ratio: "9:16", visual_style: visualStyle, beats: beatSummaries },
    episodes: [{ id: "EP_001", order: 1, title, duration: durationSeconds, content: beatSummaries.join(" ") }],
    characters, scenes,
    props: [{ id: "PROP_001", name: "关键物证", style: `符合${seed.genre}世界观的核心线索物`, description: `推动《${title}》真相揭示的关键物件`, reference_assets: [], locked: false }],
    sequences, shots,
  };
  const characterSections = characters.map((character) => [
    `【角色 ${character.id}】`,
    `名称：${character.name}`,
    `角色定位：${character.role}`,
    `性别与年龄：${character.gender}，${character.age_range}`,
    `外貌锁定：${character.appearance_lock}`,
    `服装锁定：${character.clothing_lock}`,
    `声音锁定：${character.voice_lock}`,
  ].join("\n")).join("\n\n");
  const sceneSections = scenes.map((scene) => [
    `【场景 ${scene.id}】`,
    `名称：${scene.name}`,
    `场景锁定：${scene.description}${scene.scene_lock}`,
  ].join("\n")).join("\n\n");
  const shotSections = shots.map((shot, index) => {
    const scene = scenes[shotPlans[index]!.sceneIndex]!;
    const shotCharacters = characters.filter((character) => shot.character_ids.includes(character.id as "CHAR_001" | "CHAR_002"));
    return [
    `第${index + 1}段（${shot.source_time_range.start}～${shot.source_time_range.end}秒）`,
    `屏幕比例：${shot.aspect_ratio}`,
    `景别：${shot.shot_size}`,
    `机位：${shot.camera_angle}`,
    `运镜：${shot.camera_movement}`,
    `画风设定：${shot.visual_style}`,
    `场景引用：${scene.id}｜${scene.name}`,
    `场景锁定：${scene.description}${scene.scene_lock}`,
    `人物引用：${shotCharacters.map((character) => `${character.id}｜${character.name}`).join("；")}`,
    `人物锁定：\n${shotCharacters.map((character) => `- ${character.id}｜${character.name}｜${character.appearance_lock}；${character.clothing_lock}`).join("\n")}`,
    `画面：${shot.visual}`,
    `口播台词：\n${shotPlans[index]!.dialogueLines.map((line) => `- ${line.id}｜${line.name}（${line.emotion}）：“${line.text}”`).join("\n")}`,
    `动作：${shot.action}`,
    `节奏设计：${shot.timing_plan}`,
    `声音：${shot.sound}`,
    `约束：${shot.constraints}`,
    ].join("\n");
  }).join("\n\n");
  const content = [
    "一、项目剧情",
    `标题：${title}\n主题：${seed.theme}\n基调：${seed.tone}\n一句话梗概：${summary}\n故事概要：${summary}\n屏幕比例：9:16\n画风设定：${visualStyle}`,
    "二、全局角色库",
    characterSections,
    "三、全局场景库",
    sceneSections,
    "四、分镜列表",
    shotSections,
  ].join("\n\n");
  return { title, summary, content, canonical };
}

async function main(): Promise<void> {
  if (process.argv.includes("--validate-regular-sources")) {
    const scripts = seeds.flatMap((seed) => seed.concepts.map((concept) => buildScript(seed, concept)));
    const requiredSections = ["一、项目剧情", "二、全局角色库", "三、全局场景库", "四、分镜列表", "人物锁定：", "口播台词：", "节奏设计：", "约束："];
    for (const script of scripts) {
      const missing = requiredSections.filter((section) => !script.content.includes(section));
      if (missing.length) throw new Error(`${script.title} is missing normalized sections: ${missing.join(", ")}`);
      if (script.canonical.shots.length < 1 || script.canonical.characters.length < 1 || script.canonical.scenes.length < 1) {
        throw new Error(`${script.title} has incomplete canonical data`);
      }
      const expectedShotCount = durationSeconds / fixedShotSeconds;
      if (script.canonical.shots.length !== expectedShotCount) {
        throw new Error(`${script.title} must contain exactly ${expectedShotCount} storyboard shots`);
      }
      script.canonical.shots.forEach((shot, index) => {
        const expectedStart = index * fixedShotSeconds;
        const expectedEnd = (index + 1) * fixedShotSeconds;
        if (shot.duration !== fixedShotSeconds || shot.source_time_range.start !== expectedStart || shot.source_time_range.end !== expectedEnd) {
          throw new Error(`${script.title} shot ${index + 1} must cover ${expectedStart}-${expectedEnd} seconds`);
        }
        if (!shot.visual || !shot.action || !shot.dialogue || !shot.timing_plan || !shot.sound || !shot.constraints) {
          throw new Error(`${script.title} shot ${index + 1} is missing detailed production fields`);
        }
        if (!shot.timing_plan.includes("0～3秒：") || !shot.timing_plan.includes("3～7秒：") || !shot.timing_plan.includes("7～10秒：")) {
          throw new Error(`${script.title} shot ${index + 1} is missing a complete ten-second timing plan`);
        }
        if (!script.content.includes(`第${index + 1}段（${expectedStart}～${expectedEnd}秒）`)) {
          throw new Error(`${script.title} content is missing shot ${index + 1}`);
        }
      });
    }
    const shotCount = scripts.reduce((total, script) => total + script.canonical.shots.length, 0);
    process.stdout.write(`Validated ${scripts.length} normalized regular scripts with ${shotCount} storyboard shots.\n`);
    return;
  }
  if (process.argv.includes("--validate-hot-sources")) {
    const scripts = await loadHotScriptSources();
    const reversalScripts = scripts.filter((script) => hotReversalScriptTitles.has(script.title));
    if (reversalScripts.length !== hotReversalScriptTitles.size) throw new Error("Hot reversal script source count is incomplete");
    for (const script of reversalScripts) {
      if (script.canonical.shots.length !== 12 || script.duration !== 120) throw new Error(`${script.title} must contain 12 ten-second shots`);
      script.canonical.shots.forEach((shot, index) => {
        if (shot.duration !== 10 || shot.source_time_range.start !== index * 10 || shot.source_time_range.end !== (index + 1) * 10) {
          throw new Error(`${script.title} shot ${index + 1} has an invalid fixed timeline`);
        }
        if (shot.action.split("→").length < 4 || shot.visual.length < 40 || shot.dialogue.trim().length < 20) {
          throw new Error(`${script.title} shot ${index + 1} lacks enough production detail (action beats ${shot.action.split("→").length}, visual chars ${shot.visual.length}, dialogue chars ${shot.dialogue.trim().length})`);
        }
      });
      for (const marker of ["第一条反证", "再次反咬", "终极反转", "情绪谷底"]) {
        if (!script.content.includes(marker)) throw new Error(`${script.title} is missing reversal structure marker: ${marker}`);
      }
    }
    const shotCount = scripts.reduce((total, script) => total + script.canonical.shots.length, 0);
    process.stdout.write(`Validated ${scripts.length} hot script sources with ${shotCount} storyboard shots.\n`);
    return;
  }
  const hotOnly = process.argv.includes("--hot-only");
  const regularOnly = process.argv.includes("--regular-only");
  if (hotOnly && regularOnly) throw new Error("--hot-only and --regular-only cannot be used together");
  if (!hotOnly && seeds.some((seed) => seed.concepts.length < minimumScriptsPerCategory)) {
    throw new Error("Every category seed must provide at least five concepts");
  }
  const config = loadDatabaseConfig();
  const connection = await createConnection({ ...config, charset: "utf8mb4", timezone: "Z" });
  try {
    await connection.beginTransaction();
    const [categories] = await connection.query<CategoryRow[]>(`
      SELECT c.id, c.code, c.name, COUNT(s.id) AS script_count
      FROM script_library_categories c
      LEFT JOIN script_library_scripts s ON s.category_id = c.id AND s.status = 'ACTIVE'
      WHERE c.status = 'ACTIVE'
      GROUP BY c.id, c.code, c.name
      FOR UPDATE
    `);
    const categoriesByCode = new Map(categories.map((row) => [row.code, row]));
    let inserted = 0;
    let updated = 0;
    if (!hotOnly) {
      const missingSeeds = categories.filter((row) => row.code !== hotCategoryCode && !seeds.some((seed) => seed.code === row.code));
      if (missingSeeds.length) throw new Error(`Missing seed concepts for active categories: ${missingSeeds.map((row) => row.code).join(", ")}`);
      for (const seed of seeds) {
        const category = categoriesByCode.get(seed.code);
        if (!category) throw new Error(`Script library category not found: ${seed.code}`);
        let activeCount = Number(category.script_count);
        const [titleRows] = await connection.query<RowDataPacket[]>("SELECT id,title FROM script_library_scripts WHERE category_id = ?", [category.id]);
        const existingByTitle = new Map(titleRows.map((row) => [String(row.title), String(row.id)]));
        for (const [index, concept] of seed.concepts.entries()) {
          const script = buildScript(seed, concept);
          const values = [durationSeconds, script.summary, script.content, JSON.stringify(script.canonical), stableHeat(seed.code, script.title), (index + 1) * 10];
          const existingId = existingByTitle.get(script.title);
          if (existingId) {
            await connection.execute(
              "UPDATE script_library_scripts SET duration_seconds=?,summary=?,content=?,canonical_json=?,heat_score=?,sort_order=?,status='ACTIVE' WHERE id=?",
              [...values, existingId],
            );
            updated += 1;
          } else {
            await connection.execute(
              `INSERT INTO script_library_scripts
                (id, category_id,title,duration_seconds,summary,content,canonical_json,heat_score,use_count,sort_order,status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE')`,
              [randomUUID(), category.id, script.title, ...values],
            );
            existingByTitle.set(script.title, script.title);
            activeCount += 1;
            inserted += 1;
          }
        }
        if (activeCount < minimumScriptsPerCategory) throw new Error(`${category.name} still has only ${activeCount} active scripts`);
      }
    }
    const hotCategory = categoriesByCode.get(hotCategoryCode);
    if (!hotCategory) throw new Error(`Script library category not found: ${hotCategoryCode}. Run database migrations first.`);
    const hotResult = regularOnly ? { inserted: 0, updated: 0, deleted: 0, sourceCount: 0 } : await seedHotScripts(connection, hotCategory);
    await connection.commit();
    process.stdout.write(`Normalized regular scripts (${inserted} inserted, ${updated} updated); imported ${hotResult.sourceCount} hot scripts (${hotResult.inserted} inserted, ${hotResult.updated} updated, ${hotResult.deleted} retired).\n`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
