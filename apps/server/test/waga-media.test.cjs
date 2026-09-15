const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { wagaMediaParams, wagaProfiles, wagaTaskStatus } = require('../dist/gateway/waga-media');
const { ModelGatewayService } = require('../dist/gateway/model-gateway.service');
const { WagaModelMetadataService } = require('../dist/common/waga-model-metadata.service');
const { calculateModelCredits } = require('../dist/admin/credit-price-calculator');
const { normalizePricingGroup } = require('../dist/admin/provider-pricing.service');
const field = (name, values, required = true) => ({ name, required, options: values?.map(value => typeof value === 'object' ? value : { value }) });
const ref = 'https://example.com/ref.png';
const schemas = {
  'tt-image-2': [field('images'), field('size', [{ value:'1440x2560', label:'2K Portrait (9:16)' }])],
  'tt-image-2.5': [field('images',undefined,false),field('version',['flare','sunburst']),field('aspect_ratio',['auto','9:16'],false),field('resolution',['auto','1K','2K','4K']),field('quality',['auto','high','max'],false),field('background',['opaque','transparent','auto'],false),field('size',undefined,false)],
  'banana-pro': [field('images'), field('aspectRatio',['9:16']),field('imageSize',['2K'])],
  'doubao-seedream-5-0-pro-260628': [field('images'),field('aspect_ratio',['9:16']),field('size',['2K'])],
  'mj_imagine': [field('images'),field('botType',['MID_JOURNEY','NIJI_JOURNEY']),field('aspectRatio',['9:16'])],
  'gk-video-3': [field('images',undefined,false),field('aspect_ratio',['9:16']),field('size',['720P']),field('duration',['6','10'])],
  'gk-video-3.5': [field('images'),field('aspect_ratio',['9:16']),field('resolution',['720p']),field('duration',['10'])],
  'doubao-seedance-2-5-quannengcankao': [field('image_url'),field('aspect_ratio',['9:16']),field('resolution',[{value:'480p',currently_unavailable:true},'720p']),field('duration',['10'])],
  'seedance-2.5-anmiao': [field('images'),field('aspect_ratio',['9:16'],false),field('resolution',['720p']),field('duration',['10'])],
  'hailuo-h3-quannengcankao': [field('image_url'),field('aspect_ratio',['9:16']),field('resolution',['768P','2K']),field('duration',['10'])],
  'kwvideo-v2-quannengcankao': [field('image_url'),field('aspect_ratio',['9:16']),field('resolution',['720p',{value:'1080p',requires:{version:['标准']}}]),field('duration',['10']),field('version',['Mini','快速',{value:'标准',currently_unavailable:true}])],
  'seedance-2.0-anmiao-quannengcankao': [field('image_url',undefined,false),field('aspect_ratio',['9:16'],false),field('resolution',['720p',{value:'1080p',requires:{version:['标准']}}]),field('duration',['10']),field('version',['Mini','快速','标准']),field('video_url',undefined,false)],
  'wan3.0-video-quannengcankao': [field('image_url'),field('ratio',['9:16']),field('resolution',['720P']),field('duration',['10']),field('version',['standard','prime'])],
  'omni_flash-10s': [field('images'),field('aspect_ratio',['9:16'])],
  'omni-flash': [field('images',undefined,false),field('aspect_ratio',['9:16','16:9']),field('duration',['4','6','8','10']),field('enhance_prompt',['false','true'],false),field('enable_upsample',['false','true'],false)],
  'kling-v3-video': [field('images'),field('aspect_ratio',['9:16']),field('duration',[{value:'5',currently_unavailable:true},'10','15']),field('mode',[{value:'std',currently_unavailable:true},'pro'])],
  'viduq3-turbo-cankaosheng': [field('images',undefined,false),field('resolution',['540p','720p','1080p']),field('duration',Array.from({length:14},(_,index)=>String(index+3))),field('aspect_ratio',['9:16','16:9','3:4','4:3','1:1']),field('off_peak',['false','true'],false)],
  'viduq3': [field('images'),field('aspect_ratio',['9:16']),field('resolution',['720p']),field('duration',['4','8','12','16']),field('model_variant',['turbo','pro']),field('off_peak',['false','true'])],
};
function target(code) { return { model_code:code, model_id:'model', model_alias:code, capability:wagaProfiles[code].video?'VIDEO_GENERATION':'IMAGE_GENERATION',
  api_protocol:'lingkeai_media', credit_multiplier:1, base_url:'https://example.com',generation_endpoint:'/v1/media/generate',provider_config_json:{},model_config_json:{},parameter_schema_json:schemas[code] }; }
function payload(code) { const p=wagaProfiles[code]; return { prompt:'fixture prompt', aspect_ratio:'9:16', resolution:code==='hailuo-h3-quannengcankao'?'2k':p.video?'720p':'2K', reference_images:[ref], ...(p.video?{seconds:code==='viduq3'?12:10,version:null}:{}) }; }
test('WagaAI media adapters send documented fields, required parameters and URL arrays', () => {
  const gateway = new ModelGatewayService({},{});
  for (const code of Object.keys(wagaProfiles)) {
    const request=gateway.request(target(code),payload(code),'fixture-key');
    const params=request.body.params;
    assert.equal(request.body.images,undefined,code);
    assert.deepEqual(params[wagaProfiles[code].images],[ref],code);
    assert(!Object.values(params).some(v=>v===null),code);
    for(const key of Object.keys(params)) assert(schemas[code].some(f=>f.name===key),`${code}: unknown ${key}`);
    for(const f of schemas[code].filter(f=>f.required)) assert(params[f.name]!=null,`${code}: missing ${f.name}`);
  }
});
test('Seedance 2.0 requires a reference and sends it as image_url', () => {
  const code='seedance-2.0-anmiao-quannengcankao';
  const gateway=new ModelGatewayService({},{});
  assert.throws(()=>gateway.request(target(code),{...payload(code),reference_images:[]},'fixture'),/需要参考素材/);
  const body=gateway.request(target(code),payload(code),'fixture').body;
  assert.deepEqual(body.params.image_url,[ref]);
  assert.equal(body.params.images,undefined);
  assert.equal(body.params.version,'Mini');
  assert.equal(body.params.duration,'10');
  const videoBody=gateway.request(target(code),{...payload(code),reference_images:[],video_url:'https://example.com/ref.mp4'},'fixture').body;
  assert.equal(videoBody.params.video_url,'https://example.com/ref.mp4');
  assert.equal(videoBody.params.image_url,undefined);
});
test('TT Image 2.5 supports text-to-image and up to 16 references with a priced standard edition', () => {
  const code='tt-image-2.5', gateway=new ModelGatewayService({},{});
  const textBody=gateway.request(target(code),{...payload(code),reference_images:[]},'fixture').body;
  assert.equal(textBody.params.images,undefined);
  assert.equal(textBody.params.version,'flare');
  assert.equal(textBody.params.aspect_ratio,'9:16');
  assert.equal(textBody.params.resolution,'2K');
  const styled=gateway.request(target(code),{...payload(code),quality:'max',background:'transparent'},'fixture').body;
  assert.equal(styled.params.quality,'max');
  assert.equal(styled.params.background,'transparent');
  assert.throws(()=>wagaMediaParams(code,schemas[code],{},payload(code),{submit:true,references:Array(17).fill({url:ref})}),/最多支持 16 张/);

  const pricing={name:code,channel_groups:[normalizePricingGroup({is_active:true,in_key_whitelist:true,billing_method:'按次',base_price:0.036,min_price:0.036,
    option_prices:[{param_name:'version',option_value:'sunburst',final_price:0.048,price_multiplier:1,price_addition:0.012}]})]};
  const model={id:'model',model_code:code,model_alias:code,capability:'IMAGE_GENERATION',api_protocol:'lingkeai_media',credit_cost:4,config_json:{},
    parameter_schema_json:schemas[code],resolution_prices:['1K','2K','4K'].map(resolution=>({resolution,credit_cost:4}))};
  const calculated=calculateModelCredits(model,pricing,0.01);
  assert.deepEqual(calculated.map(item=>item.credits),[4,4,4]);
  assert(calculated.every(item=>item.parameters.version==='flare'));
});
test('Seedance 2.5 requires images and sends the current images field', () => {
  const code='seedance-2.5-anmiao';
  const gateway=new ModelGatewayService({},{});
  assert.throws(()=>gateway.request(target(code),{...payload(code),reference_images:[]},'fixture'),/至少需要一张参考图/);
  const body=gateway.request(target(code),payload(code),'fixture').body;
  assert.deepEqual(body.params.images,[ref]);
  assert.equal(body.params.image_url,undefined);
  assert.equal(body.params.version,undefined);
  assert.throws(()=>gateway.request(target(code),{...payload(code),reference_images:[],audio_url:'https://example.com/ref.mp3'},'fixture'),/至少需要一张参考图/);
});
test('GK-video-3 and Omni-Flash follow their documented duration, resolution and reference limits', () => {
  const gateway=new ModelGatewayService({},{});
  const gk=gateway.request(target('gk-video-3'),{...payload('gk-video-3'),resolution:'720p',seconds:6,reference_images:[]},'fixture').body;
  assert.equal(gk.params.size,'720P');
  assert.equal(gk.params.duration,'6');
  assert.equal(gk.params.images,undefined);

  const omni=gateway.request(target('omni-flash'),{...payload('omni-flash'),resolution:'default',seconds:8,enhance_prompt:'true',enable_upsample:'true'},'fixture').body;
  assert.equal(omni.params.resolution,undefined);
  assert.equal(omni.params.duration,'8');
  assert.equal(omni.params.enhance_prompt,'true');
  assert.equal(omni.params.enable_upsample,'true');
  assert.throws(()=>wagaMediaParams('omni-flash',schemas['omni-flash'],{},payload('omni-flash'),{submit:true,references:Array(4).fill({url:ref})}),/最多支持 3 张/);
});
test('Vidu Q3 Turbo reference mode supports text fallback, seven images and all documented output choices', () => {
  const code='viduq3-turbo-cankaosheng', gateway=new ModelGatewayService({},{});
  const textBody=gateway.request(target(code),{...payload(code),reference_images:[],seconds:3,resolution:'540P',aspect_ratio:'3:4'},'fixture').body;
  assert.equal(textBody.params.images,undefined);
  assert.equal(textBody.params.resolution,'540p');
  assert.equal(textBody.params.duration,'3');
  assert.equal(textBody.params.aspect_ratio,'3:4');
  assert.equal(textBody.params.off_peak,'false');
  const referenceBody=gateway.request(target(code),{...payload(code),reference_images:Array(7).fill(ref),seconds:16,resolution:'1080p',aspect_ratio:'1:1'},'fixture').body;
  assert.equal(referenceBody.params.images.length,7);
  assert.equal(referenceBody.params.duration,'16');
  assert.throws(()=>wagaMediaParams(code,schemas[code],{},payload(code),{submit:true,references:Array(8).fill({url:ref})}),/最多支持 7 张/);
  assert.throws(()=>wagaMediaParams(code,schemas[code],{},{...payload(code),seconds:2}),/3～16 秒/);
});
test('first frame is first in both the provider array and reference label guide', () => {
  const code='kling-v3-video';
  const body=new ModelGatewayService({},{}).request(target(code),{...payload(code),reference_images:[{url:ref,label:'尾帧'},{url:'https://example.com/first.png',type:'shot_first_frame',label:'首帧'}]},'fixture').body;
  assert.equal(body.params.images[0],'https://example.com/first.png');
  assert.match(body.prompt,/第1张：首帧/);
});
test('invalid media counts, missing references, unsupported durations and editions fail before submit', () => {
  for(const code of Object.keys(wagaProfiles)) {
    assert.throws(()=>wagaMediaParams(code,schemas[code],{},payload(code),{submit:true,references:Array(wagaProfiles[code].max+1).fill({url:ref})}),/最多支持/);
    if(wagaProfiles[code].video) assert.throws(()=>wagaMediaParams(code,schemas[code],{},{...payload(code),seconds:10.5}),/时长/);
  }
  assert.throws(()=>wagaMediaParams('viduq3',schemas.viduq3,{}, {...payload('viduq3'),seconds:10}),/时长/);
  assert.throws(()=>wagaMediaParams('kling-v3-video',schemas['kling-v3-video'],{}, {...payload('kling-v3-video'),seconds:5}),/暂不可用/);
  assert.throws(()=>wagaMediaParams('kwvideo-v2-quannengcankao',schemas['kwvideo-v2-quannengcankao'],{}, {...payload('kwvideo-v2-quannengcankao'),resolution:'1080p'}),/版本不匹配/);
  assert.throws(()=>wagaMediaParams('gk-video-3.5',schemas['gk-video-3.5'],{}, {...payload('gk-video-3.5'),reference_images:undefined},{submit:true}),/至少需要一张参考图/);
});
test('quote and creation use the stored lowest-price edition without accepting overrides', () => {
  const config={generation_parameters_by_resolution:{'720p':{model_variant:'turbo',off_peak:'true'}}};
  const code='viduq3', p=payload(code);
  const quoted=wagaMediaParams(code,schemas[code],config,p);
  const sent=wagaMediaParams(code,schemas[code],config,p,{submit:true,references:[{url:ref}]});
  assert.equal(sent.off_peak,'true'); assert.equal(quoted.off_peak,sent.off_peak);
  assert.throws(()=>wagaMediaParams(code,schemas[code],config,{...p,off_peak:'false'}),/重新确认积分/);
  assert.throws(()=>wagaMediaParams('omni_flash-10s',schemas['omni_flash-10s'],{}, {...payload('omni_flash-10s'),seconds:15}),/固定生成 10 秒/);
});
test('linked price options cannot pick a cheap but impossible edition/resolution tuple', () => {
  const code='kwvideo-v2-quannengcankao';
  const model={id:'model',model_code:code,model_alias:code,capability:'VIDEO_GENERATION',api_protocol:'lingkeai_media',credit_cost:1,config_json:{},
    parameter_schema_json:schemas[code],resolution_prices:[{resolution:'1080p',credit_cost:1}]};
  const pricing={name:code,channel_groups:[normalizePricingGroup({is_active:true,in_key_whitelist:true,billing_method:'按秒',base_price:1,option_prices:[{param_name:'version',option_value:'Mini',final_price:1},{param_name:'version',option_value:'标准',final_price:2}]})]};
  assert.equal(calculateModelCredits(model,pricing,1)[0].status,'SKIPPED');
});
test('Waga completion requires is_final and a usable result, not progress or early success', () => {
  for (const value of [{state:'success',is_final:false,result_url:ref},{state:'success',progress:100},{state:'success',is_final:true},{state:'processing',is_final:false}]) assert.equal(wagaTaskStatus(value),'PROCESSING');
  assert.equal(wagaTaskStatus({state:'success',is_final:true,result_url:ref}),'SUCCEEDED');
  assert.equal(wagaTaskStatus({state:'failed',is_final:true,refunded:true}),'FAILED');
});
test('metadata reads coalesce, never POST, reject bad data without leaking secrets', async () => {
  const original=global.fetch; let calls=0;
  const service=new WagaModelMetadataService({query:async()=>[{base_url:'https://example.com/api',api_key_ciphertext:'cipher'}]},{decrypt:()=> 'private-key'});
  try {
    global.fetch=async(_url,init)=>{calls++;assert.equal(init.method,undefined);return new Response(JSON.stringify({params:schemas.viduq3}));};
    await Promise.all([service.schema('p','viduq3'),service.schema('p','viduq3')]);
    assert.equal(calls,1);
    global.fetch=async()=>new Response('private-key upstream failure',{status:500});
    await assert.rejects(service.schema('p','other'), e=>!e.message.includes('private-key')&&e.message.includes('没有扣分'));
  } finally {global.fetch=original;}
});

test('catalog uses live unavailable flags and never exposes obsolete tiers', async () => {
  const { ClientConfigService } = require('../dist/client-config/client-config.service');
  const code='doubao-seedance-2-5-quannengcankao';
  const row={...target(code),id:'model',provider_id:'p',provider_code:'wagaai',config_json:{},credit_cost:1,parameter_schema_json:[]};
  const prices=[{provider_model_id:'model',resolution:'480p',credit_cost:1},{provider_model_id:'model',resolution:'720p',credit_cost:2}];
  const service=new ClientConfigService({query:async sql=>sql.includes('FROM provider_model_resolution_prices')?prices:[row]},
    {schema:async()=>schemas[code]});
  assert.deepEqual((await service.models())[0].resolution_prices.map(p=>p.resolution),['720p']);
});
