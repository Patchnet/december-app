// Evaluation-only proposals. No parser or runtime route consumes this file.
export const intentCases=[
 {text:'Create a note called Studio: The spare key is in the blue drawer.',expected:'approve',proposal:{type:'note',name:'Studio',text:'The spare key is in the blue drawer.'}},
 {text:'Create a note called Studio: The spare key is in the blue drawer.',expected:'defer',proposal:{type:'note',name:'Studio',text:'The spare key is under the mat.'}},
 {text:'Mark Charge batteries in Camera done',expected:'approve',proposal:{type:'complete',space:'Camera',itemId:'battery',text:'Charge batteries'},context:[{space:'Camera',items:[{id:'battery',text:'Charge batteries',done:false}]}]},
 {text:'Did those three',expected:'defer',proposal:{type:'complete',space:'Camera',itemId:'battery',text:'Charge batteries'},context:[{space:'Camera',items:[{id:'battery',text:'Charge batteries',done:false}]}]},
 {text:'Remind me to call Alex on 2026-10-02',expected:'approve',proposal:{type:'reminder',text:'Call Alex',when:'2026-10-02'}},
 {text:'Remind me to call Alex sometime next week',expected:'defer',proposal:{type:'reminder',text:'Call Alex',when:'2026-10-02'}},
 {text:'Do not mark Charge batteries done',expected:'defer',proposal:{type:'complete',itemId:'battery',text:'Charge batteries'}},
 {text:'Maybe save a note about the trip',expected:'defer',proposal:{type:'note',name:'Trip',text:'We leave on Friday.'}},
]
