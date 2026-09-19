exports.fixture = () => {
  const value = structuredClone(require('../../../desktop/src/data/standard-script-example.json'));
  value.characters[0].states = [{ id: 'CHAR_001_STATE_001', name: '常态', appearance_lock: '黑发，椭圆脸，中等身材', clothing_lock: '米色风衣，黑框眼镜' }];
  value.shots.forEach((shot, index) => { shot.duration = index ? 12 : 7; shot.dialogue ||= '无'; shot.character_state_ids = { CHAR_001: 'CHAR_001_STATE_001' }; });
  return value;
};
