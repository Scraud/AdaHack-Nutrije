// Presentation fixtures only. These values never enter the dispatch planner or active plan.
export const HOURS=Array.from({length:24},(_,hour)=>String(hour).padStart(2,'0'));
export const MOCK_DEMAND=[3,2,2,1,2,4,8,12,18,24,20,17,15,18,22,28,25,19,14,11,9,7,5,4];
export const WEEKDAYS=['Pon','Tor','Sre','Čet','Pet','Sob','Ned'];
export const MOCK_VEHICLES=[
 {id:'V1',completed:27,utilization:78,average:19,empty:13,cleaning:6.8,departure:3.2},
 {id:'V2',completed:23,utilization:64,average:16,empty:18,cleaning:5.4,departure:2.6},
 {id:'V3',completed:21,utilization:73,average:21,empty:11,cleaning:7.2,departure:4.1},
 {id:'V4',completed:25,utilization:69,average:17,empty:16,cleaning:5.9,departure:2.8},
 {id:'V5',completed:24,utilization:71,average:18,empty:14,cleaning:6.3,departure:3.5},
];
export function mockHeat(day:number,hour:number){
 const morning=Math.max(0,1-Math.abs(hour-9)/4),afternoon=Math.max(0,1-Math.abs(hour-15)/4);
 return Math.round(Math.max(0,Math.min(100,12+morning*48+afternoon*63+(day<5?12:-25)+(day*11+hour*7)%17)));
}

export const MOCK_AREAS=[
 {name:'Osrednja Slovenija',lat:46.056,lon:14.505,accidents:31,transports:146,radiusKm:43},
 {name:'Maribor in okolica',lat:46.555,lon:15.646,accidents:24,transports:112,radiusKm:36},
 {name:'Celjsko območje',lat:46.239,lon:15.267,accidents:19,transports:94,radiusKm:34},
 {name:'Gorenjska',lat:46.239,lon:14.356,accidents:16,transports:83,radiusKm:37},
 {name:'Obala in Kras',lat:45.548,lon:13.730,accidents:18,transports:68,radiusKm:32},
 {name:'Dolenjska',lat:45.804,lon:15.169,accidents:14,transports:76,radiusKm:35},
 {name:'Goriška',lat:45.956,lon:13.648,accidents:12,transports:54,radiusKm:31},
 {name:'Pomurje',lat:46.662,lon:16.166,accidents:11,transports:61,radiusKm:32},
 {name:'Koroška',lat:46.510,lon:15.080,accidents:9,transports:47,radiusKm:29},
 {name:'Notranjska',lat:45.775,lon:14.213,accidents:13,transports:52,radiusKm:32},
 {name:'Ptujsko območje',lat:46.420,lon:15.870,accidents:10,transports:48,radiusKm:28},
 {name:'Zgornja Gorenjska',lat:46.435,lon:14.058,accidents:12,transports:43,radiusKm:29},
 {name:'Posavje',lat:45.901,lon:15.591,accidents:13,transports:58,radiusKm:31},
 {name:'Zasavje',lat:46.156,lon:15.054,accidents:8,transports:46,radiusKm:25},
 {name:'Posočje',lat:46.183,lon:13.733,accidents:9,transports:35,radiusKm:32},
 {name:'Kočevsko',lat:45.639,lon:14.861,accidents:7,transports:39,radiusKm:32},
 {name:'Idrijsko območje',lat:46.002,lon:14.028,accidents:6,transports:32,radiusKm:26},
 {name:'Vipavska dolina',lat:45.886,lon:13.900,accidents:10,transports:41,radiusKm:27},
].map(area=>({...area,count:area.accidents+area.transports}));
