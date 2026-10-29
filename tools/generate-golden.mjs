import fs from 'node:fs';
import { magnitudeDb } from './dsp-reference.mjs';
const sampleRate=48000;
const filters=[
  {name:'peak-1k-plus6',kind:'peak',frequencyHz:1000,gainDb:6,q:1},
  {name:'low-shelf-100-plus4',kind:'lowShelf',frequencyHz:100,gainDb:4,q:0.707},
  {name:'high-shelf-8k-minus3',kind:'highShelf',frequencyHz:8000,gainDb:-3,q:0.707},
  {name:'notch-3k',kind:'notch',frequencyHz:3000,gainDb:0,q:4}
];
const frequencies=[20,50,100,500,1000,3000,8000,16000,20000];
const out={sampleRateHz:sampleRate,frequenciesHz:frequencies,cases:filters.map(filter=>({filter,responseDb:frequencies.map(f=>Number(magnitudeDb(filter,sampleRate,f).toFixed(12)))}))};
fs.writeFileSync(new URL('../tests/golden/biquad-response.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log('wrote golden response vectors');
