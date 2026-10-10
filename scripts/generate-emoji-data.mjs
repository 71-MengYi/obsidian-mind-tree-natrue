/**
 * Generator for `src/ui/emoji-data.ts`.
 *
 * The plugin ships its emoji catalogue as source instead of adding an npm
 * dependency: `dependencies` all land in `main.js` and the release pipeline
 * caps that bundle. This script only runs when the catalogue itself changes
 * (`node scripts/generate-emoji-data.mjs`), and the generated file is committed.
 *
 * Layout: one `glyph<TAB>name<TAB>keywords` line per entry. Glyphs are written
 * as code points so editing this table can never corrupt a surrogate pair, and
 * every keyword list starts with the Simplified Chinese search terms for that
 * emoji so both languages are searchable.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SECTIONS = {
  "smileys-emotion": String.raw`
1F600	grinning face	笑脸 开心 高兴 笑
1F603	grinning face with big eyes	笑脸 大笑 开心
1F604	grinning face with smiling eyes	开心 笑 眯眼笑
1F601	beaming face with smiling eyes	开心 笑 露齿笑
1F606	grinning squinting face	大笑 露齿 眯眼
1F605	grinning face with sweat	苦笑 出汗 尴尬
1F923	rolling on the floor laughing	笑翻 大笑 爆笑 笑死
1F602	face with tears of joy	笑哭 笑死 感动 流泪笑
1F642	slightly smiling face	微笑 浅笑 礼貌
1F643	upside-down face	颠倒 反了 无语 滑稽
1FAE0	melting face	融化 崩溃 无奈 心累
1F609	winking face	眨眼 调皮 暗示
1F60A	smiling face with smiling eyes	微笑 开心 善良
1F603	smiling face	微笑 高兴
1F970	smiling face with hearts	爱心眼 喜欢 幸福 崇拜
1F60D	smiling face with heart-eyes	爱心眼 喜爱 迷恋
1F929	star-struck	星星眼 崇拜 惊艳 追星
1F618	face blowing a kiss	飞吻 亲亲 爱
1F617	kissing face	亲吻 亲亲
263A	smiling face	微笑 平静 含蓄
1F61A	kissing face with closed eyes	亲吻 闭眼 亲亲
1F619	kissing face with smiling eyes	亲吻 微笑 亲亲
1F972	smiling face with tear	含泪微笑 感激 坚强
1F60B	face savoring food	好吃 美味 馋 舔嘴
1F61B	face with tongue	吐舌 调皮
1F61C	winking face with tongue	吐舌眨眼 调皮 开玩笑
1F92A	zany face	疯狂 搞怪 发疯
1F61D	squinting face with tongue	吐舌眯眼 搞怪 调皮
1F911	money-mouth face	发财 有钱 贪财 美元
1F917	smiling face with open hands	拥抱 抱抱 支持
1F92D	face with hand over mouth	捂嘴 偷笑 惊讶
1FAE2	face with open eyes and hand over mouth	惊讶 捂嘴 震惊
1FAE3	face with peeking eye	偷看 害怕 好奇
1F92B	shushing face	嘘 安静 保密
1F914	thinking face	思考 想 疑惑 琢磨
1FAE1	saluting face	敬礼 致敬 收到
1F910	zipper-mouth face	闭嘴 保密 不说话
1F928	face with raised eyebrow	挑眉 怀疑 疑惑 质疑
1F610	neutral face	无语 面无表情 平静
1F611	expressionless face	无语 面无表情
1F636	face without mouth	沉默 无语 无话可说
1FAE5	dotted line face	隐身 消失 透明
1F60F	smirking face	得意 坏笑 自满
1F612	unamused face	不爽 不满 无语
1F644	face with rolling eyes	翻白眼 无语 鄙视
1F62C	grimacing face	龇牙 尴尬 难受
1F62E	face with open mouth	惊讶 张嘴 吃惊
1F62F	hushed face	惊讶 震惊 安静
1F632	astonished face	惊讶 震惊 呆住
1F633	flushed face	脸红 害羞 尴尬
1F97A	pleading face	恳求 委屈 可怜 拜托
1F979	face holding back tears	忍住眼泪 感动 委屈
1F626	frowning face with open mouth	难过 惊讶 张大嘴
1F627	anguished face	痛苦 难受 焦急
1F628	fearful face	害怕 恐惧 担心
1F630	anxious face with sweat	紧张 冷汗 焦虑
1F625	sad but relieved face	松了口气 释然 汗
1F622	crying face	哭 流泪 伤心
1F62D	loudly crying face	大哭 痛哭 伤心 崩溃
1F631	face screaming in fear	尖叫 恐惧 害怕 惊悚
1F616	confounded face	困惑 纠结 难受
1F623	persevering face	坚持 忍耐 难受
1F61E	disappointed face	失望 沮丧 难过
1F613	downcast face with sweat	低落 汗 泄气
1F629	weary face	疲惫 累 沮丧
1F62B	tired face	疲惫 累 困
1F971	yawning face	打哈欠 困 无聊
1F624	face with steam from nose	生气 愤怒 哼
1F621	enraged face	愤怒 生气 暴怒
1F620	angry face	生气 愤怒 不满
1F92C	face with symbols on mouth	骂人 生气 爆粗
1F608	smiling face with horns	恶魔 坏笑 调皮
1F47F	angry face with horns	恶魔 生气 坏
1F480	skull	骷髅 死亡 完了
2620	skull and crossbones	骷髅 危险 毒
1F4A9	pile of poo	便便 屎 糟糕
1F921	clown face	小丑 搞笑 荒唐
1F479	ogre	食人魔 怪物 鬼
1F47A	goblin	小妖精 怪物 鬼
1F47B	ghost	幽灵 鬼 吓人
1F47D	alien	外星人 太空 异形
1F47E	alien monster	外星怪物 游戏 像素
1F916	robot	机器人 机械 自动
1F63A	grinning cat	猫 开心 笑脸
1F638	grinning cat with smiling eyes	猫 笑 开心
1F639	cat with tears of joy	猫 笑哭
1F63B	smiling cat with heart-eyes	猫 爱心 喜欢
1F63C	cat with wry smile	猫 坏笑 得意
1F63D	kissing cat	猫 亲亲
1F640	weary cat	猫 惊讶 疲惫
1F63F	crying cat	猫 哭 伤心
1F63E	pouting cat	猫 生气 不满
1F648	see-no-evil monkey	猴子 不看 捂眼
1F649	hear-no-evil monkey	猴子 不听 捂耳
1F64A	speak-no-evil monkey	猴子 不说 捂嘴
1F48C	love letter	情书 爱 信
1F498	heart with arrow	爱心 箭 恋爱
1F49D	heart with ribbon	爱心 礼物 丝带
1F496	sparkling heart	爱心 闪亮 喜欢
1F497	growing heart	爱心 变心 喜欢
1F493	beating heart	心跳 爱心 喜欢
1F49E	revolving hearts	爱心 环绕 恋爱
1F495	two hearts	两颗心 恋爱 喜欢
1F49F	heart decoration	爱心 装饰
2763	heart exclamation	爱心 感叹
1F494	broken heart	心碎 失恋 伤心
2764	red heart	红心 爱 喜欢
1FA77	pink heart	粉心 喜欢 爱
1F9E1	orange heart	橙心 喜欢 爱
1F49B	yellow heart	黄心 友情 喜欢
1F49A	green heart	绿心 喜欢 爱
1F499	blue heart	蓝心 喜欢 爱
1F49C	purple heart	紫心 喜欢 爱
1F5A4	black heart	黑心 喜欢 暗
1F90D	white heart	白心 喜欢
1F90E	brown heart	棕心 喜欢
1F4AF	hundred points	满分 一百分 完美
1F4A2	anger symbol	怒气 生气 冲突
1F4A5	collision	碰撞 爆炸 冲突
1F4AB	dizzy	眩晕 头晕 混乱
1F4AC	speech balloon	对话 说话 评论
1F4AD	thought balloon	想法 思考 内心
1F4A4	sleeping	睡觉 睡眠 困
1F4A8	dashing away	快跑 冲刺 溜走
`.trim(),
  "people-body": String.raw`
1F44B	waving hand	挥手 你好 再见
1F91A	raised back of hand	手背 举起
1F590	hand with fingers splayed	张开手 五指
270B	raised hand	举手 停止 打招呼
1F596	vulcan salute	瓦肯 举手 星际
1F44C	OK hand	OK 好的 没问题 可以
1F90C	pinched fingers	捏手 手势 什么意思
1F90F	pinching hand	一点点 少量 手势
270C	victory hand	胜利 耶 剪刀手
1F91E	crossed fingers	好运 祈祷 期待
1FAF0	hand with index finger and thumb crossed	比心 爱心 手势
1F91F	love-you gesture	爱你 手势 比心
1F918	sign of the horns	摇滚 角 手势
1F919	call me hand	打电话 联系 手势
1F448	backhand index pointing left	指左 左边 指示
1F449	backhand index pointing right	指右 右边 指示
1F446	backhand index pointing up	指上 上面 指示
1F595	middle finger	中指 生气 挑衅
1F447	backhand index pointing down	指下 下面 指示
261D	index pointing up	指上 提醒 注意
1FAF1	rightwards hand	向右的手 牵手 握手
1FAF2	leftwards hand	向左的手 牵手 握手
1FAF3	palm down hand	手心向下 放下
1FAF4	palm up hand	手心向上 请求 托举
1F44D	thumbs up	点赞 赞 好的 同意
1F44E	thumbs down	差评 反对 不好 不行
1F44A	oncoming fist	拳头 加油 击拳
1F91B	left-facing fist	拳头 碰拳
1F91C	right-facing fist	拳头 碰拳
1F44F	clapping hands	鼓掌 拍手 棒
1F64C	raising hands	举手 万岁 庆祝
1FAF6	heart hands	比心 爱心 双手
1F450	open hands	张开双手 拥抱 什么
1F932	palms up together	双手合十 请 托付
1F91D	handshake	握手 合作 达成
1F64F	folded hands	祈祷 拜托 感谢 合十
270D	writing hand	写字 记录 笔记
1F485	nail polish	指甲油 美甲 化妆
1F933	selfie	自拍 拍照 手机
1F4AA	flexed biceps	肌肉 加油 强壮 力量
1F9BE	mechanical arm	机械臂 假肢 科技
1F9BF	mechanical leg	机械腿 假肢 科技
1F9B5	leg	腿 脚
1F9B6	foot	脚 足
1F442	ear	耳朵 听
1F9BB	ear with hearing aid	助听器 耳朵 听力
1F443	nose	鼻子 闻
1F9E0	brain	大脑 智慧 思考
1FAC0	anatomical heart	心脏 器官 健康
1FAC1	lungs	肺 器官 呼吸
1F9B7	tooth	牙齿 口腔
1F9B4	bone	骨头 骨骼
1F440	eyes	眼睛 看 关注
1F441	eye	眼睛 看 观察
1F445	tongue	舌头 尝
1F444	mouth	嘴 说话
1F464	bust in silhouette	人像 用户 匿名
1F465	busts in silhouette	人像 多人 团队
1FAC2	people hugging	拥抱 安慰 支持
1F463	footprints	脚印 足迹 走过
1F476	baby	婴儿 宝宝 小孩
1F9D2	child	小孩 儿童
1F466	boy	男孩 儿子
1F467	girl	女孩 女儿
1F9D1	person	人 人物
1F471	person blond hair	金发 人
1F468	man	男人 男性
1F9D4	person beard	胡须 人
1F469	woman	女人 女性
1F9D3	older person	老人 长者
1F474	old man	老人 爷爷
1F475	old woman	老人 奶奶
1F64D	person frowning	皱眉 不满
1F64E	person pouting	撅嘴 不满
1F645	person gesturing NO	拒绝 不行
1F646	person gesturing OK	可以 同意
1F481	person tipping hand	举手 服务 无所谓
1F64B	person raising hand	举手 提问 报名
1F9CF	deaf person	听障 手语
1F647	person bowing	鞠躬 道歉 感谢
1F926	person facepalming	捂脸 无奈 无语
1F937	person shrugging	耸肩 不知道 无所谓
1F46E	police officer	警察 民警
1F575	detective	侦探 调查
1F482	guard	卫兵 保安
1F977	ninja	忍者 隐身
1F477	construction worker	建筑工人 施工
1F934	prince	王子 皇室
1F478	princess	公主 皇室
1F473	person wearing turban	头巾 人
1F472	person with skullcap	帽子 人
1F935	person in tuxedo	礼服 婚礼 正式
1F470	person with veil	头纱 婚礼 新娘
1F930	pregnant woman	怀孕 孕妇
1FAC3	pregnant man	怀孕 男性
1FAC4	pregnant person	怀孕 人
1F931	breast-feeding	哺乳 母婴
1F47C	baby angel	天使 宝宝
1F385	Santa Claus	圣诞老人 圣诞
1F936	Mrs. Claus	圣诞奶奶 圣诞
1F9B8	superhero	超级英雄 英雄
1F9B9	supervillain	反派 坏蛋
1F9D9	mage	法师 魔法
1F9DA	fairy	仙女 精灵
1F9DB	vampire	吸血鬼 万圣节
1F9DC	merperson	美人鱼 人鱼
1F9DD	elf	精灵 小精灵
1F9DE	genie	精灵 神灯
1F9DF	zombie	僵尸 丧尸
1F486	person getting massage	按摩 放松
1F487	person getting haircut	理发 剪发
1F6B6	person walking	走路 步行
1F9CD	person standing	站立 人
1F9CE	person kneeling	跪 祈祷
1F3C3	person running	跑步 奔跑 运动
1F483	woman dancing	跳舞 舞蹈
1F57A	man dancing	跳舞 舞蹈
1F574	person in suit levitating	西装 悬浮
1F46F	people with bunny ears	兔子耳朵 派对
1F9D6	person in steamy room	桑拿 汗蒸
1F9D7	person climbing	攀爬 登山
1F93A	person fencing	击剑 运动
1F3C7	horse racing	赛马 骑手
26F7	skier	滑雪 冬季
1F3C2	snowboarder	单板滑雪 冬季
1F3CC	golfer	高尔夫 运动
1F3C4	person surfing	冲浪 运动
1F6A3	person rowing boat	划船 运动
1F6C0	person taking bath	洗澡 沐浴
1F6CC	person in bed	睡觉 床上 休息
1F46B	woman and man holding hands	牵手 情侣
1F46C	two men holding hands	牵手 情侣
1F46D	two women holding hands	牵手 情侣
1F48F	kiss	亲吻 情侣
1F491	couple with heart	情侣 爱心
1F46A	family	家庭 家人
1F5E3	speaking head silhouette	说话 侧影
1F464	bust in silhouette	人像 剪影
`.trim(),
  "animals-nature": String.raw`
1F436	dog face	狗 狗狗 宠物
1F415	dog	狗 狗狗 宠物
1F429	poodle	贵宾犬 狗 宠物
1F43A	wolf	狼 野性
1F98A	fox	狐狸 狡猾
1F99D	raccoon	浣熊 动物
1F431	cat face	猫 猫咪 宠物
1F408	cat	猫 猫咪 宠物
1F981	lion	狮子 王者
1F42F	tiger face	老虎 虎
1F405	tiger	老虎 虎
1F406	leopard	豹 猎豹
1F434	horse face	马 骏马
1F40E	horse	马 骑马
1F984	unicorn	独角兽 神话
1F993	zebra	斑马 动物
1F98C	deer	鹿 动物
1F9AC	bison	野牛 动物
1F42E	cow face	牛 奶牛
1F402	ox	公牛 牛
1F403	water buffalo	水牛 牛
1F404	cow	牛 奶牛
1F437	pig face	猪 小猪
1F416	pig	猪 小猪
1F417	boar	野猪 猪
1F43D	pig nose	猪鼻子 猪
1F40F	ram	公羊 羊
1F411	sheep	绵羊 羊
1F410	goat	山羊 羊
1F42A	camel	骆驼 沙漠
1F42B	two-hump camel	骆驼 沙漠
1F999	llama	羊驼 骆驼
1F992	giraffe	长颈鹿 动物
1F418	elephant	大象 动物
1F9A3	mammoth	猛犸象 史前
1F98F	rhinoceros	犀牛 动物
1F99B	hippopotamus	河马 动物
1F42D	mouse face	老鼠 耗子
1F401	mouse	老鼠 耗子
1F400	rat	老鼠 耗子
1F439	hamster	仓鼠 宠物
1F430	rabbit face	兔子 兔
1F407	rabbit	兔子 兔
1F43F	chipmunk	花栗鼠 松鼠
1F9AB	beaver	河狸 动物
1F994	hedgehog	刺猬 动物
1F987	bat	蝙蝠 夜晚
1F43B	bear	熊 动物
1F43C	panda	熊猫 国宝
1F9A5	sloth	树懒 慢
1F9A6	otter	水獭 动物
1F9A8	skunk	臭鼬 动物
1F998	kangaroo	袋鼠 动物
1F9A1	badger	獾 动物
1F43E	paw prints	爪印 脚印 宠物
1F983	turkey	火鸡 感恩节
1F414	chicken	鸡 小鸡
1F413	rooster	公鸡 鸡
1F423	hatching chick	小鸡 破壳
1F424	baby chick	小鸡 幼鸟
1F425	front-facing baby chick	小鸡 正面
1F426	bird	鸟 小鸟
1F427	penguin	企鹅 南极
1F54A	dove	鸽子 和平
1F985	eagle	老鹰 鹰
1F986	duck	鸭子 鸭
1F9A2	swan	天鹅 优雅
1F989	owl	猫头鹰 智慧
1F9A4	dodo	渡渡鸟 灭绝
1FAB6	feather	羽毛 轻
1F9A9	flamingo	火烈鸟 粉色
1F99A	peacock	孔雀 华丽
1F99C	parrot	鹦鹉 学舌
1F438	frog	青蛙 蛙
1F40A	crocodile	鳄鱼 爬行
1F422	turtle	乌龟 龟
1F98E	lizard	蜥蜴 爬行
1F40D	snake	蛇 爬行
1F432	dragon face	龙 龙头
1F409	dragon	龙 神话
1F995	sauropod	恐龙 长颈龙
1F996	T-Rex	恐龙 霸王龙
1F433	spouting whale	鲸鱼 喷水
1F40B	whale	鲸鱼 大海
1F42C	dolphin	海豚 大海
1F41F	fish	鱼 小鱼
1F420	tropical fish	热带鱼 鱼
1F421	blowfish	河豚 鱼
1F988	shark	鲨鱼 危险
1F419	octopus	章鱼 触手
1F41A	spiral shell	贝壳 海螺
1FAB8	coral	珊瑚 海洋
1F40C	snail	蜗牛 慢
1F98B	butterfly	蝴蝶 美丽
1F41B	bug	虫子 昆虫
1F41C	ant	蚂蚁 昆虫
1F41D	honeybee	蜜蜂 蜂蜜
1FAB2	beetle	甲虫 昆虫
1F41E	lady beetle	瓢虫 昆虫
1F997	cricket	蟋蟀 昆虫
1FAB3	cockroach	蟑螂 害虫
1F577	spider	蜘蛛 网
1F578	spider web	蜘蛛网 网
1F982	scorpion	蝎子 毒
1F99F	mosquito	蚊子 叮
1FAB0	fly	苍蝇 昆虫
1FAB1	worm	蠕虫 虫
1F9A0	microbe	微生物 病毒 细菌
1F490	bouquet	花束 鲜花 礼物
1F338	cherry blossom	樱花 春天
1F4AE	white flower	白花 花
1F3F5	rosette	花结 奖章
1F339	rose	玫瑰 爱情 花
1F940	wilted flower	枯萎 花 凋谢
1F33A	hibiscus	木槿 花
1F33B	sunflower	向日葵 花
1F33C	blossom	花朵 花
1F337	tulip	郁金香 花
1F331	seedling	幼苗 发芽 生长
1FAB4	potted plant	盆栽 植物
1F332	evergreen tree	常青树 树
1F333	deciduous tree	落叶树 树
1F334	palm tree	棕榈树 海滩
1F335	cactus	仙人掌 沙漠
1F33E	sheaf of rice	稻穗 收获
1F33F	herb	草药 植物
2618	shamrock	三叶草 幸运
1F340	four leaf clover	四叶草 幸运
1F341	maple leaf	枫叶 秋天
1F342	fallen leaf	落叶 秋天
1F343	leaf fluttering in wind	风吹叶 秋天
1FAB9	empty nest	空巢 鸟巢
1FABA	nest with eggs	鸟巢 蛋
1F344	mushroom	蘑菇 菌
1FAB7	lotus	莲花 荷花
1F33A	hibiscus	花 热带
1F33B	sunflower	向日葵 阳光
1F30D	globe showing Europe-Africa	地球 世界
1F30E	globe showing Americas	地球 美洲
1F30F	globe showing Asia-Australia	地球 亚洲
1F310	globe with meridians	地球 经线
1F5FA	world map	世界地图 地图
1F5FB	mount fuji	富士山 山
1F30B	volcano	火山 喷发
1F5FE	map of Japan	日本地图 地图
1F3D4	snow-capped mountain	雪山 山
26F0	mountain	山 登山
1F30C	milky way	银河 星空
1F30A	water wave	海浪 水
1F301	foggy	雾 模糊
1F303	night with stars	夜晚 星星
1F3D9	cityscape	城市 建筑
1F304	sunrise over mountains	日出 山
1F305	sunrise	日出 早晨
1F306	cityscape at dusk	黄昏 城市
1F307	sunset	日落 傍晚
1F309	bridge at night	夜桥 夜晚
1F30E	earth americas	地球
2600	sun	太阳 晴天
1F31D	full moon face	满月 月亮
1F31A	new moon face	新月 月亮
1F311	new moon	月亮 新月
1F31E	sun with face	太阳 晴天
2B50	star	星星 收藏 好评
1F31F	glowing star	闪耀 星星
1F320	shooting star	流星 许愿
1F30C	milky way	银河
2601	cloud	云 多云
26C5	sun behind cloud	多云 晴间多云
26C8	cloud with lightning and rain	雷阵雨 天气
1F324	sun behind small cloud	多云 天气
1F325	sun behind large cloud	阴天 天气
1F326	sun behind rain cloud	阵雨 天气
1F327	cloud with rain	下雨 雨
1F328	cloud with snow	下雪 雪
1F329	cloud with lightning	闪电 雷
1F32A	tornado	龙卷风 天气
1F32B	fog	雾 天气
1F32C	wind face	风 天气
1F308	rainbow	彩虹 好运
1F302	closed umbrella	雨伞 关闭
2602	umbrella	雨伞 下雨
26A1	high voltage	闪电 高压 电
2744	snowflake	雪花 冬天
1F4A7	droplet	水滴 水
1F30A	water wave	波浪 水
1F525	fire	火 火焰 热门 燃烧
1F4A5	collision	碰撞 爆炸
`.trim(),
  "food-drink": String.raw`
1F34F	green apple	青苹果 苹果 水果
1F34E	red apple	苹果 水果
1F350	pear	梨 水果
1F34A	tangerine	橘子 柑橘 水果
1F34B	lemon	柠檬 水果 酸
1F34C	banana	香蕉 水果
1F349	watermelon	西瓜 水果
1F347	grapes	葡萄 水果
1F353	strawberry	草莓 水果
1FAD0	blueberries	蓝莓 水果
1F348	melon	甜瓜 水果
1F352	cherries	樱桃 水果
1F351	peach	桃子 水果
1F96D	mango	芒果 水果
1F34D	pineapple	菠萝 水果
1F965	coconut	椰子 热带
1F95D	kiwi fruit	猕猴桃 奇异果
1F345	tomato	西红柿 番茄 蔬菜
1FAD2	olive	橄榄 地中海
1F346	eggplant	茄子 蔬菜
1F951	avocado	牛油果 鳄梨
1FAD1	bell pepper	甜椒 蔬菜
1F952	cucumber	黄瓜 蔬菜
1F96C	leafy green	绿叶菜 蔬菜
1F966	broccoli	西兰花 蔬菜
1F9C4	garlic	大蒜 蒜
1F9C5	onion	洋葱 蔬菜
1F955	carrot	胡萝卜 蔬菜
1FAD4	tamale	玉米粽 食物
1F954	potato	土豆 马铃薯
1F360	roasted sweet potato	烤红薯 地瓜
1F950	croissant	牛角包 面包
1F96F	bagel	贝果 面包
1F35E	bread	面包 吐司
1F956	baguette bread	法棍 面包
1FAD3	flatbread	扁面包 饼
1F968	pretzel	椒盐卷饼 面包
1F9C0	cheese wedge	奶酪 芝士
1F95A	egg	鸡蛋 蛋
1F373	cooking	煎蛋 烹饪
1F9C8	butter	黄油 奶油
1F95E	pancakes	煎饼 松饼
1F9C7	waffle	华夫饼 早餐
1F953	bacon	培根 肉
1F969	cut of meat	肉 牛排
1F357	poultry leg	鸡腿 肉
1F356	meat on bone	骨头肉 肉
1F32D	hot dog	热狗 快餐
1F354	hamburger	汉堡 快餐
1F35F	french fries	薯条 快餐
1F355	pizza	披萨 比萨
1F96A	sandwich	三明治 快餐
1F32E	taco	墨西哥卷 快餐
1F32F	burrito	墨西哥卷饼 快餐
1FAD5	fondue	芝士火锅 火锅
1F959	 stuffed flatbread	馅饼 食物
1F9C6	dumpling	饺子 水饺
1F95F	dumpling	饺子 汤圆
1F962	chopsticks	筷子 餐具
1F35C	steaming bowl	拉面 面条 热汤
1F35D	spaghetti	意大利面 面条
1F35B	curry rice	咖喱饭 米饭
1F363	sushi	寿司 日本料理
1F364	fried shrimp	炸虾 海鲜
1F365	fish cake with swirl	鱼板 关东煮
1F96E	moon cake	月饼 中秋
1F361	dango	团子 日本
1F958	shallow pan of food	平底锅 炖菜
1F35F	french fries	薯条
1F95D	kiwi	奇异果
1F957	green salad	沙拉 蔬菜
1F37F	popcorn	爆米花 电影
1F9C2	salt	盐 调味
1F96B	canned food	罐头 食物
1F371	bento box	便当 饭盒
1F358	rice cracker	米饼 仙贝
1F359	rice ball	饭团 日本
1F35A	cooked rice	米饭 白饭
1F35C	steaming bowl	面条 拉面
1F35D	spaghetti	意面
1F35E	bread	面包
1F35F	fries	薯条
1F361	dango	团子
1F362	oden	关东煮
1F363	sushi	寿司
1F366	soft ice cream	冰淇淋 甜筒
1F367	shaved ice	刨冰 甜点
1F368	ice cream	冰淇淋 甜点
1F369	doughnut	甜甜圈 甜点
1F36A	cookie	曲奇 饼干
1F382	birthday cake	生日蛋糕 庆祝
1F370	shortcake	蛋糕 草莓蛋糕
1F9C1	cupcake	纸杯蛋糕 甜点
1F967	pie	派 馅饼
1F36B	chocolate bar	巧克力 甜食
1F36C	candy	糖果 甜食
1F36D	lollipop	棒棒糖 糖果
1F36E	custard	布丁 蛋奶
1F36F	honey pot	蜂蜜 甜
1F37C	baby bottle	奶瓶 婴儿
1F95B	glass of milk	牛奶 饮品
2615	hot beverage	咖啡 热饮 茶
1FAD6	teapot	茶壶 茶
1F375	teacup without handle	茶杯 茶
1F376	sake	清酒 日本酒
1F37E	bottle with popping cork	香槟 庆祝
1F377	wine glass	红酒 酒杯
1F378	cocktail glass	鸡尾酒 酒吧
1F379	tropical drink	热带饮料 果汁
1F37A	beer mug	啤酒 干杯
1F37B	clinking beer mugs	干杯 啤酒
1F942	clinking glasses	碰杯 庆祝
1F943	tumbler glass	威士忌 酒杯
1F964	cup with straw	饮料 吸管
1F9CB	bubble tea	奶茶 珍珠奶茶
1F9C3	beverage box	盒装饮料 果汁
1F9C9	mate	马黛茶 茶
1F9CA	ice	冰块 冰
1F962	chopsticks	筷子
1F374	fork and knife	餐具 吃饭
1F944	spoon	勺子 餐具
1F52A	kitchen knife	菜刀 刀
1F3FA	amphora	陶罐 古董
`.trim(),
  "travel-places": String.raw`
1F697	automobile	汽车 轿车
1F695	taxi	出租车 打车
1F699	sport utility vehicle	越野车 SUV
1F68C	bus	公交车 巴士
1F68E	trolleybus	无轨电车 公交
1F3CE	racing car	赛车 跑车
1F693	police car	警车 警察
1F691	ambulance	救护车 急救
1F692	fire engine	消防车 救火
1F690	minibus	小巴 面包车
1F69A	delivery truck	货车 卡车
1F69B	articulated lorry	卡车 货车
1F69C	tractor	拖拉机 农业
1F3F1	racing car	赛车
1F6F5	motor scooter	踏板车 摩托
1F3CD	motorcycle	摩托车 机车
1F6B2	bicycle	自行车 单车 骑行
1F6F4	kick scooter	滑板车 电动
1F6F9	skateboard	滑板 运动
1F68F	bus stop	公交站 车站
1F6E3	motorway	高速公路 公路
1F6E4	railway track	铁轨 铁路
1F6A2	ship	轮船 船
26F5	sailboat	帆船 船
1F6A4	speedboat	快艇 船
1F6F3	passenger ship	客船 邮轮
26F4	ferry	渡轮 船
1F6E5	motor boat	摩托艇 船
1F6A5	horizontal traffic light	红绿灯 交通
1F6A6	vertical traffic light	红绿灯 交通
1F6A7	construction	施工 道路施工
1F6A8	police car light	警灯 警报
1F6A9	triangular flag	三角旗 旗帜
1F6AA	door	门 入口
1F6AB	no entry	禁止进入 禁止
1F6AC	cigarette	香烟 吸烟
1F6AD	no smoking	禁止吸烟
1F6AF	no littering	禁止乱扔 垃圾
1F6B0	potable water	饮用水 水
1F6B1	non-potable water	非饮用水 水
1F6B3	no bicycles	禁止自行车
1F6B7	no pedestrians	禁止行人
1F6B8	children crossing	儿童过街 注意
1F6B9	men's room	男厕 洗手间
1F6BA	women's room	女厕 洗手间
1F6BB	restroom	洗手间 厕所
1F6BC	baby symbol	婴儿 标识
1F6BE	water closet	厕所 WC
1F6C2	passport control	护照检查 出入境
1F6C3	customs	海关 检查
1F6C4	baggage claim	行李提取 机场
1F6C5	left luggage	行李寄存 寄存
26A0	warning	警告 注意 危险
1F6B8	children crossing	儿童
1F3E0	house	房子 家
1F3E1	house with garden	花园住宅 家
1F3E2	office building	办公楼 公司
1F3E3	Japanese post office	邮局 日本
1F3E4	post office	邮局 邮政
1F3E5	hospital	医院 医疗
1F3E6	bank	银行 金融
1F3E8	hotel	酒店 住宿
1F3E9	love hotel	情侣酒店 住宿
1F3EA	convenience store	便利店 商店
1F3EB	school	学校 教育
1F3EC	department store	百货商店 购物
1F3ED	factory	工厂 制造
1F3EF	Japanese castle	城堡 日本
1F3F0	castle	城堡 宫殿
1F492	wedding	婚礼 结婚
1F5FC	Tokyo tower	东京塔 地标
1F5FD	Statue of Liberty	自由女神像 地标
26EA	church	教堂 宗教
1F54C	mosque	清真寺 宗教
1F54D	synagogue	犹太教堂 宗教
26E9	shinto shrine	神社 日本
1F54B	kaaba	天房 麦加
26F2	fountain	喷泉 公园
26FA	tent	帐篷 露营
1F301	foggy	雾 桥
1F3D5	camping	露营 户外
1F3D6	beach with umbrella	海滩 度假
1F3D7	building construction	建筑施工 工地
1F3D8	houses	房屋 住宅
1F3DA	derelict house	废弃房屋 破旧
1F3DC	desert	沙漠 沙
1F3DD	desert island	荒岛 海岛
1F3DE	national park	国家公园 自然
1F3DF	stadium	体育场 比赛
1F3DB	classical building	古典建筑 地标
1F3D4	snow mountain	雪山
1F30B	volcano	火山
1F5FB	mount fuji	富士山
1F3D9	cityscape	城市
1F3DA	derelict house	废墟
1F309	bridge at night	夜景
1F30C	milky way	银河
1F3A0	carousel horse	旋转木马 游乐
1F3A1	ferris wheel	摩天轮 游乐场
1F3A2	roller coaster	过山车 游乐场
1F3A3	fishing pole	钓鱼 鱼竿
1F3A4	studio microphone	麦克风 录音
1F3A5	movie camera	摄影机 电影
1F3A6	cinema	电影院 电影
1F3A7	headphone	耳机 音乐
1F3A8	artist palette	调色板 艺术 绘画
1F3A9	top hat	礼帽 帽子
1F3AA	circus tent	马戏团 帐篷
1F3AB	ticket	门票 票
1F3AC	clapper board	场记板 电影
1F3AD	performing arts	表演 戏剧
1F3AE	video game	电子游戏 手柄
1F3AF	direct hit	正中靶心 目标 命中
1F3B0	slot machine	老虎机 赌博
1F3B1	billiards	台球 桌球
1F3B2	game die	骰子 游戏
1F3B3	bowling	保龄球 运动
1F3B4	flower playing cards	花札 纸牌
1F3B5	musical note	音符 音乐
1F3B6	musical notes	音符 音乐
1F3B7	saxophone	萨克斯 乐器
1F3B8	guitar	吉他 乐器
1F3B9	musical keyboard	电子琴 乐器
1F3BA	trumpet	小号 乐器
1F3BB	violin	小提琴 乐器
1F3BC	musical score	乐谱 音乐
1F3BD	running shirt	运动服 跑步
1F3BE	tennis	网球 运动
1F3BF	skis	滑雪板 冬季
1F3C0	basketball	篮球 运动
1F3C1	chequered flag	格子旗 终点
1F3C2	snowboarder	单板滑雪
1F3C3	person running	跑步
1F3C4	person surfing	冲浪
1F3C5	person lifting weights	举重 健身
1F3C6	trophy	奖杯 冠军 胜利
1F3C8	american football	橄榄球 运动
1F3C9	rugby football	橄榄球 运动
1F3CA	person swimming	游泳 泳池
1F3CB	person biking	骑车 运动
1F3CC	golfer	高尔夫
1F3CD	motorcycle	摩托
1F3CE	racing car	赛车
1F3CF	cricket game	板球 运动
1F3D0	volleyball	排球 运动
1F3D1	field hockey	曲棍球 运动
1F3D2	ice hockey	冰球 运动
1F3D3	ping pong	乒乓球 运动
1F3D4	snow mountain	雪山
1F3D5	camping	露营
1F3D6	beach umbrella	海滩
1F3D7	construction	工地
1F3D8	houses	住宅
1F3D9	cityscape	城市
1F3DA	derelict house	废弃
1F3DB	classical building	古典建筑
1F3DC	desert	沙漠
1F3DD	desert island	荒岛
1F3DE	national park	国家公园
1F3DF	stadium	体育场
1F3E0	house	家
26BD	soccer ball	足球 运动
26BE	baseball	棒球 运动
1F94E	softball	垒球 运动
1F94F	flying disc	飞盘 运动
1F3C0	basketball	篮球
1F3D0	volleyball	排球
1F3C8	american football	橄榄球
1F3BE	tennis	网球
1F94A	boxing glove	拳击手套 拳击
1F94B	martial arts uniform	武术 道服
1F945	goal net	球门 进球
26F3	flag in hole	高尔夫球洞 进洞
26F8	ice skate	溜冰 冰鞋
1F3A3	fishing pole	钓鱼
1F3BD	running shirt	运动服
1F3BF	skis	滑雪
1F6F7	sled	雪橇 冬季
1F680	rocket	火箭 发射 升空 launch spaceship
1F6F8	flying saucer	飞碟 UFO
1F6F9	skateboard	滑板
1F6FA	auto rickshaw	三轮车 嘟嘟车
1F6FB	pickup truck	皮卡 卡车
1F6FC	roller skate	轮滑 旱冰
1F6A2	ship	轮船
1F6A4	speedboat	快艇
1F6F3	passenger ship	邮轮
1F6E5	motor boat	摩托艇
1F6A5	traffic light	红绿灯
1F6A7	construction	施工
1F6A8	police light	警灯
1F6A9	triangular flag	三角旗
1F6AA	door	门
1F6AB	no entry	禁止进入
1F6AC	cigarette	香烟
1F6AD	no smoking	禁止吸烟
1F6AE	litter bin	垃圾桶 垃圾
1F6B0	potable water	饮用水
1F6B2	bicycle	自行车
1F6B3	no bicycles	禁止自行车
1F6B4	person mountain biking	山地骑行
1F6B5	person mountain biking	骑行
1F6B6	person walking	走路
1F6B7	no pedestrians	禁止行人
1F6B9	men's room	男厕
1F6BA	women's room	女厕
1F6BB	restroom	洗手间
1F6BC	baby symbol	婴儿
1F6BE	water closet	厕所
1F6BF	shower	淋浴 洗澡
1F6C0	person taking bath	洗澡
1F6C1	bathtub	浴缸 泡澡
1F6C2	passport control	护照检查
1F6C3	customs	海关
1F6C4	baggage claim	行李提取
1F6C5	left luggage	行李寄存
`.trim(),
  "objects": String.raw`
231A	watch	手表 时间
1F4F1	mobile phone	手机 电话
1F4F2	mobile phone with arrow	手机 接收
260E	telephone	电话 座机
1F4DE	telephone receiver	电话 听筒
1F4DF	pager	传呼机 寻呼
1F4E0	fax machine	传真 办公
1F50B	battery	电池 电量
1F50C	electric plug	插头 电源
1F4BB	laptop	笔记本电脑 电脑
1F5A5	desktop computer	台式电脑 显示器
1F5A8	printer	打印机 办公
2328	keyboard	键盘 输入
1F5B1	computer mouse	鼠标 电脑
1F5B2	trackball	轨迹球 鼠标
1F4BD	computer disk	光盘 存储
1F4BE	floppy disk	软盘 存储
1F4BF	optical disk	光盘 CD
1F4C0	dvd	DVD 光盘
1F9EE	abacus	算盘 计算
1F3A5	movie camera	摄影机
1F4F7	camera	相机 拍照
1F4F8	camera with flash	相机 闪光灯
1F4F9	video camera	摄像机 录像
1F4FA	television	电视 节目
1F4FB	radio	收音机 广播
1F4FC	videocassette	录像带 磁带
1F50D	magnifying glass tilted left	放大镜 搜索 查找
1F50E	magnifying glass tilted right	放大镜 搜索
1F56F	candle	蜡烛 光
1F4A1	light bulb	灯泡 想法 灵感
1F526	flashlight	手电筒 照明
1F3EE	red paper lantern	灯笼 日本
1F4D4	notebook with decorative cover	笔记本 本子
1F4D5	closed book	书 关闭
1F4D6	open book	书 打开 阅读
1F4D7	green book	书 绿色
1F4D8	blue book	书 蓝色
1F4D9	orange book	书 橙色
1F4DA	books	书 书籍 阅读
1F4D3	notebook	笔记本 记录
1F4D2	ledger	账本 记录
1F4C3	page with curl	文件 页面
1F4DC	scroll	卷轴 文件
1F4C4	page facing up	文件 文档
1F4F0	newspaper	报纸 新闻
1F5DE	rolled-up newspaper	报纸 新闻
1F4D1	bookmark tabs	书签 标签
1F516	bookmark	书签 收藏
1F4CE	paperclip	回形针 附件
1F587	linked paperclips	回形针 链接
1F4CF	straight ruler	直尺 测量
1F4D0	triangular ruler	三角尺 测量
2702	scissors	剪刀 剪切
1F5C2	card index dividers	文件夹 分类
1F4C1	file folder	文件夹 目录
1F4C2	open file folder	打开文件夹 目录
1F5C3	card file box	卡片盒 档案
1F5C4	file cabinet	文件柜 档案
1F5D1	wastebasket	垃圾桶 删除
1F512	locked	锁 加密 安全
1F513	unlocked	开锁 解锁
1F50F	locked with pen	锁定 签署
1F510	locked with key	锁定 密钥
1F511	key	钥匙 解锁 密码
1F5DD	old key	旧钥匙 钥匙
1F528	hammer	锤子 工具
1FA93	axe	斧头 工具
26CF	pick	镐 工具
2692	hammer and pick	锤镐 工具
1F6E0	hammer and wrench	工具 维修
1F5E1	dagger	匕首 刀
2694	crossed swords	交叉剑 战斗
1F52B	water pistol	水枪 玩具
1F3F9	bow and arrow	弓箭 射箭
1F6E1	shield	盾牌 防护
1F527	wrench	扳手 工具 维修
1F529	nut and bolt	螺母螺栓 工具
2699	gear	齿轮 设置 配置
1F5DC	clamp	夹具 固定
2696	balance scale	天平 公平 权衡
1F517	link	链接 关联
26D3	chains	链条 束缚
1F9F0	toolbox	工具箱 工具
1F9F1	brick	砖块 建筑
1FAA8	rock	石头 岩石
1FAB5	wood	木头 木材
1F6D6	hut	小屋 木屋
1F6D7	elevator	电梯 升降
1F6D8	elevator	电梯
1F6DD	playground slide	滑梯 游乐
1F6DE	wheel	轮子 车轮
1F6DF	ring buoy	救生圈 安全
1F9AF	probing cane	盲杖 无障碍
1F9BD	manual wheelchair	手动轮椅 无障碍
1F9BC	motorized wheelchair	电动轮椅 无障碍
1F9BA	safety vest	安全背心 反光
1F9BB	ear with hearing aid	助听器
1F9AC	bison	野牛
1F9AD	seal	海豹 动物
1F9AE	guide dog	导盲犬 无障碍
1FAE0	melting face	融化
1FAF0	hand with index finger	比心
1F9F2	magnet	磁铁 吸引
1F9F3	luggage	行李箱 旅行
1F9F4	lotion bottle	乳液 护肤
1F9F5	thread	线 缝纫
1F9F6	yarn	毛线 编织
1F9F7	safety pin	别针 安全
1F9F8	teddy bear	泰迪熊 玩偶
1F9F9	broom	扫帚 打扫
1F9FA	basket	篮子 购物
1F9FB	roll of paper	卷纸 卫生纸
1F9FC	soap	肥皂 清洁
1F9FD	sponge	海绵 清洁
1F9FE	receipt	收据 小票
1F9FF	nazar amulet	护身符 辟邪
1FA70	ballet shoes	芭蕾舞鞋 舞蹈
1FA71	one-piece swimsuit	连体泳衣 游泳
1FA72	briefs	内裤 内衣
1FA73	shorts	短裤 服装
1FA74	thong sandal	人字拖 拖鞋
1FA78	drop of blood	血滴 血液
1FA79	adhesive bandage	创可贴 伤口
1FA7A	stethoscope	听诊器 医疗
1FA7B	x-ray	X光 医学
1FA7C	crutch	拐杖 受伤
1FA80	yo-yo	悠悠球 玩具
1FA81	kite	风筝 玩具
1FA82	parachute	降落伞 跳伞
1FA83	boomerang	回旋镖 玩具
1FA84	magic wand	魔法棒 魔法
1FA85	piñata	皮纳塔 派对
1FA86	nesting dolls	套娃 俄罗斯
1FA90	ringed planet	行星 土星 太空
1FA91	chair	椅子 家具
1FA92	razor	剃须刀 刮胡
1FA93	axe	斧头
1FA94	diya lamp	油灯 排灯节
1FA95	banjo	班卓琴 乐器
1FA96	military helmet	军用头盔 头盔
1FA97	sledge	雪橇
1FA98	accordion	手风琴 乐器
1FA99	coin	硬币 钱
1FA9A	carpentry saw	锯子 木工
1FA9B	screwdriver	螺丝刀 工具
1FA9C	ladder	梯子 攀爬
1FA9D	hook	钩子 挂
1FA9E	mirror	镜子 反射
1FA9F	window	窗户 视窗
1FAA0	plunger	皮搋子 疏通
1FAA1	sewing needle	缝衣针 缝纫
1FAA2	knot	绳结 打结
1FAA3	bucket	水桶 桶
1FAA4	mouse trap	捕鼠夹 陷阱
1FAA5	toothbrush	牙刷 清洁
1FAA6	headstone	墓碑 纪念
1FAA7	placard	标语牌 抗议
1FAA8	rock	石头
1FAA9	mirror ball	镜面球 迪斯科
1FAAA	identification card	身份证 证件
1FAAB	low battery	电量低 电池
1FAAC	hamsa	法蒂玛之手 护身
1FAB0	fly	苍蝇
1FAB1	worm	蠕虫
1FAB2	beetle	甲虫
1FAB3	cockroach	蟑螂
1FAB4	potted plant	盆栽
1FAB5	wood	木头
1FAB6	feather	羽毛
1FAB7	lotus	莲花
1FAB8	coral	珊瑚
1FAB9	empty nest	空巢
1FABA	nest with eggs	鸟巢
1F4B0	money bag	钱袋 金钱 财富
1F4B4	yen banknote	日元 钞票
1F4B5	dollar banknote	美元 钞票
1F4B6	euro banknote	欧元 钞票
1F4B7	pound banknote	英镑 钞票
1F4B8	money with wings	飞钱 花钱
1F4B3	credit card	信用卡 支付
1F9FE	receipt	收据
1F4B9	chart increasing with yen	涨势 金融
1F4B2	heavy dollar sign	美元 金钱
1F4B1	currency exchange	汇率 兑换
1F4DD	memo	备忘录 笔记
1F4E7	e-mail	邮件 电子邮件
1F4E8	incoming envelope	收信 邮件
1F4E9	envelope with arrow	发信 邮件
1F4E4	outbox tray	发件箱 邮件
1F4E5	inbox tray	收件箱 邮件
1F4E6	package	包裹 快递
1F4EB	closed mailbox with raised flag	邮箱 邮件
1F4EA	closed mailbox with lowered flag	邮箱 邮件
1F4EC	open mailbox with raised flag	邮箱 邮件
1F4ED	open mailbox with lowered flag	邮箱 邮件
1F4EE	postbox	邮筒 邮箱
1F4EF	postal horn	邮号 邮政
1F4E2	loudspeaker	扩音器 公告
1F4E3	megaphone	喇叭 宣传
1F4E1	satellite antenna	卫星天线 信号
1F4E0	fax	传真
1F4F1	mobile phone	手机
1F4F2	phone with arrow	手机
1F4F3	vibration mode	震动 手机
1F4F4	mobile phone off	关机 手机
1F4F5	no mobile phones	禁止手机
1F4F6	antenna bars	信号 网络
1F4F7	camera	相机
1F4F9	video camera	摄像
1F4FC	videocassette	录像带
1F50A	speaker high volume	音量 扬声器
1F50B	battery	电池
1F50C	plug	插头
1F50D	magnifying glass	放大镜 搜索
1F50E	magnifying glass	放大镜
`.trim(),
  "symbols": String.raw`
2705	check mark button	对勾 完成 正确 通过
274C	cross mark	叉 错误 取消 失败
274E	cross mark button	叉 错误
2757	exclamation mark	感叹号 注意
2753	question mark	问号 疑问
2755	white exclamation mark	感叹号 提醒
2049	exclamation question mark	疑问 感叹
203C	double exclamation mark	双感叹号 注意
26A0	warning	警告 注意
1F6AB	no entry	禁止
1F6D1	stop sign	停止 停
1F6A9	triangular flag	旗帜
1F3F4	black flag	黑旗 旗帜
1F3F3	white flag	白旗 投降
1F3C1	chequered flag	格子旗 终点
1F6A9	flag	旗帜
2691	black flag	黑旗
2690	white flag	白旗
2B06	up arrow	向上 箭头
2197	up-right arrow	右上 箭头
27A1	right arrow	向右 箭头 下一步
2198	down-right arrow	右下 箭头
2B07	down arrow	向下 箭头
2199	down-left arrow	左下 箭头
2B05	left arrow	向左 箭头 返回
2196	up-left arrow	左上 箭头
2195	up-down arrow	上下 箭头
2194	left-right arrow	左右 箭头
21A9	right arrow curving left	返回 回复
21AA	left arrow curving right	转发 前进
2934	right arrow curving up	向上弯 箭头
2935	right arrow curving down	向下弯 箭头
1F503	clockwise vertical arrows	刷新 循环 同步
1F504	anticlockwise arrows button	重试 刷新
1F519	BACK arrow	返回 后退
1F51A	END arrow	结束 末尾
1F51B	ON arrow	开启 上
1F51C	SOON arrow	即将 稍后
1F51D	TOP arrow	顶部 置顶
1F500	shuffle tracks button	随机 打乱
1F501	repeat button	重复 循环
1F502	repeat single button	单曲循环 重复
25B6	play button	播放 开始
23E9	fast-forward button	快进 加速
23ED	next track button	下一首 下一个
23EF	play or pause button	播放暂停
25C0	reverse button	倒放 反向
23EA	fast reverse button	快退 倒退
23EE	last track button	上一首 上一个
1F53C	upwards button	向上 增加
23EB	fast up button	快速向上
1F53D	downwards button	向下 减少
23EC	fast down button	快速向下
23F8	pause button	暂停
23F9	stop button	停止
23FA	record button	录制 录音
23F1	stopwatch	秒表 计时
23F2	timer clock	定时器 计时
23F0	alarm clock	闹钟 提醒
1F570	mantelpiece clock	座钟 时钟
231A	watch	手表 时间
231B	hourglass done	沙漏 时间到
23F3	hourglass not done	沙漏 计时中
1F4A1	light bulb	灯泡 想法
1F526	flashlight	手电筒
1F506	brightness high	亮度高 明亮
1F505	brightness low	亮度低 暗
1F507	muted speaker	静音 无声
1F508	speaker low volume	低音量 音量
1F509	speaker medium volume	中音量 音量
1F50A	speaker high volume	高音量 音量
1F514	bell	铃铛 提醒 通知
1F515	bell with slash	静音 关闭提醒
1F4E3	megaphone	喇叭 公告
1F4E2	loudspeaker	扩音器
1F4E2	loudspeaker	广播
1F6A8	police car light	警灯
1F6A9	triangular flag	旗帜
267B	recycling symbol	回收 环保
267E	infinity	无限 无穷
267F	wheelchair symbol	无障碍 轮椅
2693	anchor	锚 停泊
26A1	high voltage	闪电 电
26AA	white circle	白圈 圆
26AB	black circle	黑圈 圆
26B0	coffin	棺材 死亡
26B1	funeral urn	骨灰盒 葬礼
26BD	soccer ball	足球
26BE	baseball	棒球
26C4	snowman without snow	雪人 冬天
26C5	sun behind cloud	多云
26CE	Ophiuchus	蛇夫座 星座
26D4	no entry	禁止通行
26EA	church	教堂
26F2	fountain	喷泉
26F3	flag in hole	高尔夫
26F5	sailboat	帆船
26FA	tent	帐篷
26FD	fuel pump	加油站 加油
2705	check mark	对勾
2708	airplane	飞机 航班
2709	envelope	信封
270A	raised fist	举拳 加油
270B	raised hand	举手
270C	victory hand	胜利
270D	writing hand	写字
270F	pencil	铅笔 编辑
2712	black nib	钢笔尖 编辑
2714	check mark	对勾 完成
2716	multiply	乘号 关闭
271D	latin cross	十字架 宗教
2721	star of David	六芒星 犹太
2728	sparkles	闪光 新 闪亮
2733	eight-spoked asterisk	星号
2734	eight-pointed star	八角星
2744	snowflake	雪花
2747	sparkle	闪光
274C	cross mark	叉
274E	cross mark	叉
2753	question mark	问号
2754	white question mark	问号
2755	white exclamation	感叹号
2757	exclamation	感叹号
2763	heart exclamation	爱心感叹
2764	red heart	红心
2795	plus	加号 添加
2796	minus	减号 移除
2797	divide	除号
27A1	right arrow	右箭头
27B0	curly loop	卷曲环
27BF	double curly loop	双卷曲环
2934	arrow curving up	弯箭头
2935	arrow curving down	弯箭头
2B05	left arrow	左箭头
2B06	up arrow	上箭头
2B07	down arrow	下箭头
2B1B	black large square	黑方块
2B1C	white large square	白方块
2B50	star	星星
2B55	hollow red circle	红圈 正确
3030	wavy dash	波浪线
303D	part alternation mark	交替标记
3297	congratulations	祝贺 恭喜
3299	secret	秘密
1F4A2	anger	怒气
1F4A3	bomb	炸弹 爆炸
1F4A4	sleeping	睡觉
1F4A5	collision	碰撞
1F4A6	sweat droplets	汗滴
1F4A8	dashing away	冲刺
1F4A9	pile of poo	便便
1F4AA	flexed biceps	肌肉
1F4AB	dizzy	眩晕
1F4AC	speech balloon	对话
1F4AD	thought balloon	想法
1F4AE	white flower	白花
1F4AF	hundred points	满分
1F4B0	money bag	钱袋
1F4B3	credit card	信用卡
1F4B9	chart increasing	涨势
1F4BC	briefcase	公文包 工作
1F4C5	calendar	日历 日期
1F4C6	tear-off calendar	日历 日期
1F4C7	card index	卡片索引
1F4C8	chart increasing	上升图表 增长
1F4C9	chart decreasing	下降图表 减少
1F4CA	bar chart	柱状图 数据
1F4CB	clipboard	剪贴板 清单
1F4CC	pushpin	图钉 固定
1F4CD	round pushpin	图钉 位置
1F4CE	paperclip	回形针
1F4CF	straight ruler	直尺
1F4D0	triangular ruler	三角尺
1F4D1	bookmark tabs	书签
1F4D2	ledger	账本
1F4D3	notebook	笔记本
1F4D4	notebook	笔记本
1F4D5	closed book	书
1F4D6	open book	书
1F4D7	green book	书
1F4D8	blue book	书
1F4D9	orange book	书
1F4DA	books	书
1F4DB	name badge	名牌 胸牌
1F4DC	scroll	卷轴
1F4DD	memo	备忘录
1F4DE	telephone receiver	电话
1F4DF	pager	传呼机
1F4E0	fax machine	传真
1F4E1	satellite antenna	卫星天线
1F4E2	loudspeaker	扩音器
1F4E3	megaphone	喇叭
1F4E4	outbox tray	发件箱
1F4E5	inbox tray	收件箱
1F4E6	package	包裹
1F4E7	e-mail	邮件
1F4E8	incoming envelope	收信
1F4E9	envelope with arrow	发信
1F4EA	mailbox	邮箱
1F4EB	mailbox	邮箱
1F4EC	mailbox	邮箱
1F4ED	mailbox	邮箱
1F4EE	postbox	邮筒
1F4EF	postal horn	邮号
1F4F0	newspaper	报纸
1F4F3	vibration mode	震动
1F4F4	mobile phone off	关机
1F4F5	no mobile phones	禁止手机
1F4F6	antenna bars	信号
1F4F8	camera with flash	相机
1F4F9	video camera	摄像机
1F4FA	television	电视
1F4FB	radio	收音机
1F4FC	videocassette	录像带
1F4FD	film projector	放映机 电影
1F4FE	portable stereo	音响 音乐
1F4FF	prayer beads	念珠 祈祷
1F500	shuffle	随机
1F501	repeat	重复
1F502	repeat single	单曲循环
1F503	clockwise arrows	刷新
1F504	anticlockwise arrows	重试
1F505	brightness low	亮度低
1F506	brightness high	亮度高
1F507	muted speaker	静音
1F508	speaker low	低音量
1F509	speaker medium	中音量
1F50A	speaker high	高音量
1F50B	battery	电池
1F50C	plug	插头
1F50D	magnifying glass	放大镜 搜索
1F50E	magnifying glass	放大镜 搜索
1F50F	locked with pen	锁定
1F510	locked with key	锁定
1F511	key	钥匙
1F512	locked	锁
1F513	unlocked	开锁
1F514	bell	铃铛
1F515	bell with slash	静音
1F516	bookmark	书签
1F517	link	链接
1F518	radio button	单选按钮
1F519	BACK arrow	返回
1F51A	END arrow	结束
1F51B	ON arrow	开启
1F51C	SOON arrow	稍后
1F51D	TOP arrow	置顶
1F51E	no one under eighteen	十八禁 限制
1F51F	keycap ten	十 数字
1F520	input latin uppercase	大写字母 输入
1F521	input latin lowercase	小写字母 输入
1F522	input numbers	数字 输入
1F523	input symbols	符号 输入
1F524	input latin letters	字母 输入
1F525	fire	火 火焰 热门
1F526	flashlight	手电筒
1F527	wrench	扳手
1F528	hammer	锤子
1F529	nut and bolt	螺母
1F52A	kitchen knife	菜刀
1F52B	water pistol	水枪
1F52C	microscope	显微镜 科学
1F52D	telescope	望远镜 天文
1F52E	crystal ball	水晶球 占卜
1F52F	dotted six-pointed star	六芒星
1F530	Japanese symbol for beginner	新手 初学者
1F531	trident emblem	三叉戟 标志
1F532	black square button	黑色方块按钮
1F533	white square button	白色方块按钮
1F534	red circle	红圈
1F535	blue circle	蓝圈
1F536	large orange diamond	橙色菱形
1F537	large blue diamond	蓝色菱形
1F538	small orange diamond	橙色小菱形
1F539	small blue diamond	蓝色小菱形
1F53A	red triangle pointed up	红色向上三角
1F53B	red triangle pointed down	红色向下三角
1F53C	upwards button	向上
1F53D	downwards button	向下
`.trim(),
  "flags": String.raw`
1F3C1	chequered flag	格子旗 终点
1F6A9	triangular flag	三角旗
1F38C	crossed flags	交叉旗 庆祝
1F3F4	black flag	黑旗
1F3F3	white flag	白旗
1F3F3-FE0F-200D-1F308	rainbow flag	彩虹旗 骄傲
1F3F3-FE0F-200D-26A7	transgender flag	跨性别旗
1F3F4-200D-2620	pirate flag	海盗旗
1F1E6-1F1E8	flag Ascension Island	国旗 阿森松岛
1F1E6-1F1E9	flag Andorra	国旗 安道尔
1F1E6-1F1EA	flag United Arab Emirates	国旗 阿联酋
1F1E6-1F1EB	flag Afghanistan	国旗 阿富汗
1F1E6-1F1EC	flag Antigua and Barbuda	国旗 安提瓜
1F1E6-1F1EE	flag Anguilla	国旗 安圭拉
1F1E6-1F1F1	flag Albania	国旗 阿尔巴尼亚
1F1E6-1F1F2	flag Armenia	国旗 亚美尼亚
1F1E6-1F1F4	flag Angola	国旗 安哥拉
1F1E6-1F1F6	flag Antarctica	国旗 南极洲
1F1E6-1F1F7	flag Argentina	国旗 阿根廷
1F1E6-1F1F8	flag American Samoa	国旗 美属萨摩亚
1F1E6-1F1F9	flag Austria	国旗 奥地利
1F1E6-1F1FA	flag Australia	国旗 澳大利亚
1F1E6-1F1FC	flag Aruba	国旗 阿鲁巴
1F1E6-1F1FD	flag Aland Islands	国旗 奥兰群岛
1F1E6-1F1FF	flag Azerbaijan	国旗 阿塞拜疆
1F1E7-1F1E6	flag Bosnia and Herzegovina	国旗 波黑
1F1E7-1F1E7	flag Barbados	国旗 巴巴多斯
1F1E7-1F1E9	flag Bangladesh	国旗 孟加拉国
1F1E7-1F1EA	flag Belgium	国旗 比利时
1F1E7-1F1EB	flag Burkina Faso	国旗 布基纳法索
1F1E7-1F1EC	flag Bulgaria	国旗 保加利亚
1F1E7-1F1ED	flag Bahrain	国旗 巴林
1F1E7-1F1EE	flag Burundi	国旗 布隆迪
1F1E7-1F1EF	flag Benin	国旗 贝宁
1F1E7-1F1F1	flag St Barthelemy	国旗
1F1E7-1F1F2	flag Bermuda	国旗 百慕大
1F1E7-1F1F3	flag Brunei	国旗 文莱
1F1E7-1F1F4	flag Bolivia	国旗 玻利维亚
1F1E7-1F1F6	flag Caribbean Netherlands	国旗
1F1E7-1F1F7	flag Brazil	国旗 巴西
1F1E7-1F1F8	flag Bahamas	国旗 巴哈马
1F1E7-1F1F9	flag Bhutan	国旗 不丹
1F1E7-1F1FC	flag Botswana	国旗 博茨瓦纳
1F1E7-1F1FE	flag Belarus	国旗 白俄罗斯
1F1E7-1F1FF	flag Belize	国旗 伯利兹
1F1E8-1F1E6	flag Canada	国旗 加拿大
1F1E8-1F1E8	flag Cocos Islands	国旗
1F1E8-1F1E9	flag Congo Kinshasa	国旗 刚果金
1F1E8-1F1EB	flag Central African Republic	国旗 中非
1F1E8-1F1EC	flag Congo Brazzaville	国旗 刚果布
1F1E8-1F1ED	flag Switzerland	国旗 瑞士
1F1E8-1F1EE	flag Cote d Ivoire	国旗 科特迪瓦
1F1E8-1F1F0	flag Cook Islands	国旗 库克群岛
1F1E8-1F1F1	flag Chile	国旗 智利
1F1E8-1F1F2	flag Cameroon	国旗 喀麦隆
1F1E8-1F1F3	flag China	国旗 中国 五星红旗
1F1E8-1F1F4	flag Colombia	国旗 哥伦比亚
1F1E8-1F1F5	flag Clipperton Island	国旗
1F1E8-1F1F7	flag Costa Rica	国旗 哥斯达黎加
1F1E8-1F1FA	flag Cuba	国旗 古巴
1F1E8-1F1FB	flag Cape Verde	国旗 佛得角
1F1E8-1F1FC	flag Curacao	国旗 库拉索
1F1E8-1F1FD	flag Christmas Island	国旗
1F1E8-1F1FE	flag Cyprus	国旗 塞浦路斯
1F1E8-1F1FF	flag Czechia	国旗 捷克
1F1E9-1F1EA	flag Germany	国旗 德国
1F1E9-1F1EC	flag Diego Garcia	国旗
1F1E9-1F1EF	flag Djibouti	国旗 吉布提
1F1E9-1F1F0	flag Denmark	国旗 丹麦
1F1E9-1F1F2	flag Dominica	国旗 多米尼克
1F1E9-1F1F4	flag Dominican Republic	国旗 多米尼加
1F1E9-1F1FF	flag Algeria	国旗 阿尔及利亚
1F1EA-1F1E6	flag Ceuta and Melilla	国旗
1F1EA-1F1E8	flag Ecuador	国旗 厄瓜多尔
1F1EA-1F1EA	flag Estonia	国旗 爱沙尼亚
1F1EA-1F1EC	flag Egypt	国旗 埃及
1F1EA-1F1ED	flag Western Sahara	国旗 西撒哈拉
1F1EA-1F1F7	flag Eritrea	国旗 厄立特里亚
1F1EA-1F1F8	flag Spain	国旗 西班牙
1F1EA-1F1F9	flag Ethiopia	国旗 埃塞俄比亚
1F1EA-1F1FA	flag European Union	旗帜 欧盟
1F1EB-1F1EE	flag Finland	国旗 芬兰
1F1EB-1F1EF	flag Fiji	国旗 斐济
1F1EB-1F1F0	flag Falkland Islands	国旗
1F1EB-1F1F2	flag Micronesia	国旗 密克罗尼西亚
1F1EB-1F1F4	flag Faroe Islands	国旗 法罗群岛
1F1EB-1F1F7	flag France	国旗 法国
1F1EC-1F1E6	flag Gabon	国旗 加蓬
1F1EC-1F1E7	flag United Kingdom	国旗 英国
1F1EC-1F1E9	flag Grenada	国旗 格林纳达
1F1EC-1F1EA	flag Georgia	国旗 格鲁吉亚
1F1EC-1F1EB	flag French Guiana	国旗 法属圭亚那
1F1EC-1F1EC	flag Guernsey	国旗 根西岛
1F1EC-1F1ED	flag Ghana	国旗 加纳
1F1EC-1F1EE	flag Gibraltar	国旗 直布罗陀
1F1EC-1F1F1	flag Greenland	国旗 格陵兰
1F1EC-1F1F2	flag Gambia	国旗 冈比亚
1F1EC-1F1F3	flag Guinea	国旗 几内亚
1F1EC-1F1F5	flag Guadeloupe	国旗 瓜德罗普
1F1EC-1F1F6	flag Equatorial Guinea	国旗 赤道几内亚
1F1EC-1F1F7	flag Greece	国旗 希腊
1F1EC-1F1F8	flag South Georgia	国旗
1F1EC-1F1F9	flag Guatemala	国旗 危地马拉
1F1EC-1F1FA	flag Guam	国旗 关岛
1F1EC-1F1FC	flag Guinea-Bissau	国旗 几内亚比绍
1F1EC-1F1FE	flag Guyana	国旗 圭亚那
1F1ED-1F1F0	flag Hong Kong SAR China	国旗 香港
1F1ED-1F1F2	flag Heard and McDonald Islands	国旗
1F1ED-1F1F3	flag Honduras	国旗 洪都拉斯
1F1ED-1F1F7	flag Croatia	国旗 克罗地亚
1F1ED-1F1F9	flag Haiti	国旗 海地
1F1ED-1F1FA	flag Hungary	国旗 匈牙利
1F1EE-1F1E8	flag Canary Islands	国旗
1F1EE-1F1E9	flag Indonesia	国旗 印度尼西亚
1F1EE-1F1EA	flag Ireland	国旗 爱尔兰
1F1EE-1F1F1	flag Israel	国旗 以色列
1F1EE-1F1F2	flag Isle of Man	国旗 马恩岛
1F1EE-1F1F3	flag India	国旗 印度
1F1EE-1F1F4	flag British Indian Ocean Territory	国旗
1F1EE-1F1F6	flag Iraq	国旗 伊拉克
1F1EE-1F1F7	flag Iran	国旗 伊朗
1F1EE-1F1F8	flag Iceland	国旗 冰岛
1F1EE-1F1F9	flag Italy	国旗 意大利
1F1EF-1F1EA	flag Jersey	国旗 泽西岛
1F1EF-1F1F2	flag Jamaica	国旗 牙买加
1F1EF-1F1F4	flag Jordan	国旗 约旦
1F1EF-1F1F5	flag Japan	国旗 日本
1F1F0-1F1EA	flag Kenya	国旗 肯尼亚
1F1F0-1F1EC	flag Kyrgyzstan	国旗 吉尔吉斯斯坦
1F1F0-1F1ED	flag Cambodia	国旗 柬埔寨
1F1F0-1F1EE	flag Kiribati	国旗 基里巴斯
1F1F0-1F1F2	flag Comoros	国旗 科摩罗
1F1F0-1F1F3	flag St Kitts and Nevis	国旗
1F1F0-1F1F5	flag North Korea	国旗 朝鲜
1F1F0-1F1F7	flag South Korea	国旗 韩国
1F1F0-1F1FC	flag Kuwait	国旗 科威特
1F1F0-1F1FE	flag Cayman Islands	国旗 开曼群岛
1F1F0-1F1FF	flag Kazakhstan	国旗 哈萨克斯坦
1F1F1-1F1E6	flag Laos	国旗 老挝
1F1F1-1F1E7	flag Lebanon	国旗 黎巴嫩
1F1F1-1F1E8	flag St Lucia	国旗 圣卢西亚
1F1F1-1F1EE	flag Liechtenstein	国旗 列支敦士登
1F1F1-1F1F0	flag Sri Lanka	国旗 斯里兰卡
1F1F1-1F1F7	flag Liberia	国旗 利比里亚
1F1F1-1F1F8	flag Lesotho	国旗 莱索托
1F1F1-1F1F9	flag Lithuania	国旗 立陶宛
1F1F1-1F1FA	flag Luxembourg	国旗 卢森堡
1F1F1-1F1FB	flag Latvia	国旗 拉脱维亚
1F1F1-1F1FE	flag Libya	国旗 利比亚
1F1F2-1F1E6	flag Morocco	国旗 摩洛哥
1F1F2-1F1E8	flag Monaco	国旗 摩纳哥
1F1F2-1F1E9	flag Moldova	国旗 摩尔多瓦
1F1F2-1F1EA	flag Montenegro	国旗 黑山
1F1F2-1F1EB	flag St Martin	国旗
1F1F2-1F1EC	flag Madagascar	国旗 马达加斯加
1F1F2-1F1ED	flag Marshall Islands	国旗 马绍尔群岛
1F1F2-1F1F0	flag North Macedonia	国旗 北马其顿
1F1F2-1F1F1	flag Mali	国旗 马里
1F1F2-1F1F2	flag Myanmar	国旗 缅甸
1F1F2-1F1F3	flag Mongolia	国旗 蒙古
1F1F2-1F1F4	flag Macao SAR China	国旗 澳门
1F1F2-1F1F5	flag Northern Mariana Islands	国旗
1F1F2-1F1F6	flag Martinique	国旗 马提尼克
1F1F2-1F1F7	flag Mauritania	国旗 毛里塔尼亚
1F1F2-1F1F8	flag Montserrat	国旗 蒙特塞拉特
1F1F2-1F1F9	flag Malta	国旗 马耳他
1F1F2-1F1FA	flag Mauritius	国旗 毛里求斯
1F1F2-1F1FB	flag Maldives	国旗 马尔代夫
1F1F2-1F1FC	flag Malawi	国旗 马拉维
1F1F2-1F1FD	flag Mexico	国旗 墨西哥
1F1F2-1F1FE	flag Malaysia	国旗 马来西亚
1F1F2-1F1FF	flag Mozambique	国旗 莫桑比克
1F1F3-1F1E6	flag Namibia	国旗 纳米比亚
1F1F3-1F1E8	flag New Caledonia	国旗 新喀里多尼亚
1F1F3-1F1EA	flag Niger	国旗 尼日尔
1F1F3-1F1EB	flag Norfolk Island	国旗 诺福克岛
1F1F3-1F1EC	flag Nigeria	国旗 尼日利亚
1F1F3-1F1EE	flag Nicaragua	国旗 尼加拉瓜
1F1F3-1F1F1	flag Netherlands	国旗 荷兰
1F1F3-1F1F4	flag Norway	国旗 挪威
1F1F3-1F1F5	flag Nepal	国旗 尼泊尔
1F1F3-1F1F7	flag Nauru	国旗 瑙鲁
1F1F3-1F1FA	flag Niue	国旗 纽埃
1F1F3-1F1FF	flag New Zealand	国旗 新西兰
1F1F4-1F1F2	flag Oman	国旗 阿曼
1F1F5-1F1E6	flag Panama	国旗 巴拿马
1F1F5-1F1EA	flag Peru	国旗 秘鲁
1F1F5-1F1EB	flag French Polynesia	国旗 法属波利尼西亚
1F1F5-1F1EC	flag Papua New Guinea	国旗 巴布亚新几内亚
1F1F5-1F1ED	flag Philippines	国旗 菲律宾
1F1F5-1F1F0	flag Pakistan	国旗 巴基斯坦
1F1F5-1F1F1	flag Poland	国旗 波兰
1F1F5-1F1F2	flag St Pierre and Miquelon	国旗
1F1F5-1F1F3	flag Pitcairn Islands	国旗
1F1F5-1F1F7	flag Puerto Rico	国旗 波多黎各
1F1F5-1F1F8	flag Palestinian Territories	国旗 巴勒斯坦
1F1F5-1F1F9	flag Portugal	国旗 葡萄牙
1F1F5-1F1FC	flag Palau	国旗 帕劳
1F1F5-1F1FE	flag Paraguay	国旗 巴拉圭
1F1F6-1F1E6	flag Qatar	国旗 卡塔尔
1F1F7-1F1EA	flag Reunion	国旗 留尼汪
1F1F7-1F1F4	flag Romania	国旗 罗马尼亚
1F1F7-1F1F8	flag Serbia	国旗 塞尔维亚
1F1F7-1F1FA	flag Russia	国旗 俄罗斯
1F1F7-1F1FC	flag Rwanda	国旗 卢旺达
1F1F8-1F1E6	flag Saudi Arabia	国旗 沙特
1F1F8-1F1E7	flag Solomon Islands	国旗 所罗门群岛
1F1F8-1F1E8	flag Seychelles	国旗 塞舌尔
1F1F8-1F1E9	flag Sudan	国旗 苏丹
1F1F8-1F1EA	flag Sweden	国旗 瑞典
1F1F8-1F1EC	flag Singapore	国旗 新加坡
1F1F8-1F1ED	flag St Helena	国旗
1F1F8-1F1EE	flag Slovenia	国旗 斯洛文尼亚
1F1F8-1F1EF	flag Svalbard and Jan Mayen	国旗
1F1F8-1F1F0	flag Slovakia	国旗 斯洛伐克
1F1F8-1F1F1	flag Sierra Leone	国旗 塞拉利昂
1F1F8-1F1F2	flag San Marino	国旗 圣马力诺
1F1F8-1F1F3	flag Senegal	国旗 塞内加尔
1F1F8-1F1F4	flag Somalia	国旗 索马里
1F1F8-1F1F7	flag Suriname	国旗 苏里南
1F1F8-1F1F8	flag South Sudan	国旗 南苏丹
1F1F8-1F1F9	flag Sao Tome and Principe	国旗
1F1F8-1F1FB	flag El Salvador	国旗 萨尔瓦多
1F1F8-1F1FD	flag Sint Maarten	国旗
1F1F8-1F1FE	flag Syria	国旗 叙利亚
1F1F8-1F1FF	flag Eswatini	国旗 斯威士兰
1F1F9-1F1E6	flag Tristan da Cunha	国旗
1F1F9-1F1E8	flag Turks and Caicos Islands	国旗
1F1F9-1F1E9	flag Chad	国旗 乍得
1F1F9-1F1EB	flag French Southern Territories	国旗
1F1F9-1F1EC	flag Togo	国旗 多哥
1F1F9-1F1ED	flag Thailand	国旗 泰国
1F1F9-1F1EF	flag Tajikistan	国旗 塔吉克斯坦
1F1F9-1F1F0	flag Tokelau	国旗 托克劳
1F1F9-1F1F1	flag Timor-Leste	国旗 东帝汶
1F1F9-1F1F2	flag Turkmenistan	国旗 土库曼斯坦
1F1F9-1F1F3	flag Tunisia	国旗 突尼斯
1F1F9-1F1F4	flag Tonga	国旗 汤加
1F1F9-1F1F7	flag Turkey	国旗 土耳其
1F1F9-1F1F9	flag Trinidad and Tobago	国旗 特立尼达
1F1F9-1F1FB	flag Tuvalu	国旗 图瓦卢
1F1F9-1F1FC	flag Taiwan	国旗 台湾
1F1F9-1F1FF	flag Tanzania	国旗 坦桑尼亚
1F1FA-1F1E6	flag Ukraine	国旗 乌克兰
1F1FA-1F1EC	flag Uganda	国旗 乌干达
1F1FA-1F1F2	flag US Outlying Islands	国旗
1F1FA-1F1F3	flag United Nations	旗帜 联合国
1F1FA-1F1F8	flag United States	国旗 美国
1F1FA-1F1FE	flag Uruguay	国旗 乌拉圭
1F1FA-1F1FF	flag Uzbekistan	国旗 乌兹别克斯坦
1F1FB-1F1E6	flag Vatican City	国旗 梵蒂冈
1F1FB-1F1E8	flag St Vincent and Grenadines	国旗
1F1FB-1F1EA	flag Venezuela	国旗 委内瑞拉
1F1FB-1F1EC	flag British Virgin Islands	国旗
1F1FB-1F1EE	flag US Virgin Islands	国旗
1F1FB-1F1F3	flag Vietnam	国旗 越南
1F1FB-1F1FA	flag Vanuatu	国旗 瓦努阿图
1F1FC-1F1EB	flag Wallis and Futuna	国旗
1F1FC-1F1F8	flag Samoa	国旗 萨摩亚
1F1FD-1F1F0	flag Kosovo	国旗 科索沃
1F1FE-1F1EA	flag Yemen	国旗 也门
1F1FE-1F1F9	flag Mayotte	国旗 马约特
1F1FF-1F1E6	flag South Africa	国旗 南非
1F1FF-1F1F2	flag Zambia	国旗 赞比亚
1F1FF-1F1FC	flag Zimbabwe	国旗 津巴布韦
`.trim()
};

/** Deduplicate by glyph while preserving the first (richest) definition. */
const seen = new Map();
for (const [category, body] of Object.entries(SECTIONS)) {
  for (const line of body.split("\n")) {
    const [codepoints, name, keywords] = line.split("\t");
    if (!codepoints || !name) throw new Error(`Malformed entry: ${line}`);
    const glyph = codepoints
      .split("-")
      .map((part) => String.fromCodePoint(Number.parseInt(part, 16)))
      .join("");
    const existing = seen.get(glyph);
    if (existing) {
      // Keep the first name and merge the extra keywords into the same entry.
      const merged = new Set([...existing.keywords.split(/\s+/), ...(keywords ?? "").split(/\s+/)]);
      merged.delete("");
      existing.keywords = [...merged].join(" ");
      continue;
    }
    seen.set(glyph, { glyph, name, keywords: keywords ?? "", category });
  }
}

const entries = [...seen.values()];
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "emoji-data.ts");
const body = entries.map((entry) =>
  `  { g: ${JSON.stringify(entry.glyph)}, n: ${JSON.stringify(entry.name)}, k: ${JSON.stringify(entry.keywords)}, c: ${JSON.stringify(entry.category)} },`
).join("\n");

writeFileSync(target, `/**
 * Offline emoji catalogue for the marker picker. GENERATED FILE — do not edit by
 * hand; run \`node scripts/generate-emoji-data.mjs\` after changing that table.
 *
 * The plugin deliberately ships this list instead of depending on an npm emoji
 * package: every \`dependency\` lands in \`main.js\`, which the release pipeline
 * caps at 10 MiB, and the picker must work fully offline.
 *
 * Field names are short because the whole table is a bundle-size decision:
 * - \`g\` the glyph that gets stored as the marker value
 * - \`n\` English name, also the accessible label
 * - \`k\` search keywords; Simplified Chinese terms come first so both languages
 *       can find the emoji
 * - \`c\` category id, used for the "all" order and the empty-result hint
 *
 * ${entries.length} entries.
 */
export interface EmojiCatalogEntry {
  readonly g: string;
  readonly n: string;
  readonly k: string;
  readonly c: string;
}

export const EMOJI_CATALOG: readonly EmojiCatalogEntry[] = [
${body}
];
`);
console.log(`wrote ${entries.length} emoji to ${target}`);
