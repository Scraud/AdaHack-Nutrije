import { bootstrapApplication } from '@angular/platform-browser';
import { Dispatcher } from './app/dashboard/dispatcher';

bootstrapApplication(Dispatcher).catch(error => console.error(error));
