// Never constructs or resumes audio until an explicit user permission gesture.
export class ActionAudio {
  constructor(factory=()=>new (window.AudioContext||window.webkitAudioContext)()) {
    this.factory=factory;this.context=null;this.enabled=false;this.ready=false;this.generation=0;this.voice=null;
  }
  async allow(enabled) {
    this.cancel();this.enabled=enabled;this.ready=false;
    if(!enabled)return false;
    const generation=this.generation;
    try {
      this.context??=this.factory();
      await this.context.resume();
      if(generation!==this.generation||!this.enabled)return false;
      this.ready=true;return true;
    } catch {if(generation===this.generation)this.enabled=false;return false;}
  }
  cancel() {
    this.generation++;
    if(this.voice) {
      try {this.voice.oscillator.stop();} catch { /* already ended */ }
      this.voice.oscillator.disconnect();this.voice.gain.disconnect();this.voice=null;
    }
  }
  // Custom beep pattern: `repeat` beeps of `ms` each, separated by equal gaps.
  beep(freq,ms,repeat) {
    if(!this.enabled||!this.ready||this.context?.state!=='running'||this.voice)return false;
    const context=this.context, oscillator=context.createOscillator(),gain=context.createGain(),now=context.currentTime,length=ms/1000;
    const voice={oscillator,gain};this.voice=voice;
    oscillator.type='sine';oscillator.frequency.value=freq;gain.gain.setValueAtTime(.0001,now);
    for(let i=0;i<repeat;i++) {
      const start=now+i*length*2;
      gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(.05,start+Math.min(.015,length/4));
      gain.gain.setValueAtTime(.05,start+length*.8);gain.gain.exponentialRampToValueAtTime(.0001,start+length);
    }
    oscillator.connect(gain);gain.connect(context.destination);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();if(this.voice===voice)this.voice=null;};
    oscillator.start(now);oscillator.stop(now+length*(repeat*2-1)+.02);
    return true;
  }
  play() {
    if(!this.enabled||!this.ready||this.context?.state!=='running'||this.voice)return;
    const context=this.context, oscillator=context.createOscillator(),gain=context.createGain(),now=context.currentTime;
    const voice={oscillator,gain};this.voice=voice;
    oscillator.type='sine';oscillator.frequency.value=660;
    gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.045,now+.015);
    gain.gain.exponentialRampToValueAtTime(.0001,now+.15);
    oscillator.connect(gain);gain.connect(context.destination);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();if(this.voice===voice)this.voice=null;};
    oscillator.start(now);oscillator.stop(now+.16);
  }
}
