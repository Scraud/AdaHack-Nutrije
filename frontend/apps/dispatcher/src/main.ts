import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent,{providers:[provideZonelessChangeDetection()]}).catch(error=>{
  console.error(error);
  document.body.textContent='Vmesnika ni bilo mogoče zagnati. Osvežite stran.';
});
