import { Component, Input } from '@angular/core';
import { LucideAngularModule, Ambulance, LayoutDashboard, Bell, Truck, RotateCcw, Clock3, ChevronDown, ChevronRight, MapPin, Users, Cross, Accessibility, Wind, AlertTriangle, CircleCheck, CircleHelp, Sparkles, Search, SlidersHorizontal, X, Check, ArrowUpRight, Map, CalendarDays, Layers, Radio, Activity, CircleDot, List, Eye, Pin, RefreshCw, LoaderCircle, Maximize2, Route, ExternalLink, ShieldCheck } from 'lucide-angular';
const icons = {ambulance:Ambulance,dashboard:LayoutDashboard,bell:Bell,truck:Truck,reset:RotateCcw,clock:Clock3,chevron:ChevronDown,right:ChevronRight,pin:MapPin,users:Users,cross:Cross,wheelchair:Accessibility,oxygen:Wind,alert:AlertTriangle,check:CircleCheck,help:CircleHelp,sparkles:Sparkles,search:Search,filter:SlidersHorizontal,close:X,done:Check,up:ArrowUpRight,map:Map,calendar:CalendarDays,layers:Layers,radio:Radio,activity:Activity,dot:CircleDot,list:List,eye:Eye,pinned:Pin,refresh:RefreshCw,loader:LoaderCircle,maximize:Maximize2,route:Route,external:ExternalLink,shield:ShieldCheck};
@Component({selector:'app-icon',standalone:true,imports:[LucideAngularModule],template:'<lucide-icon [img]="icon" [size]="size" [strokeWidth]="1.8" aria-hidden="true" />',host:{'[style.display]':'"inline-flex"','[style.flex-shrink]':'"0"'}})
export class IconComponent {
  @Input() name = 'dashboard';
  @Input() size = 18;
  get icon() { return icons[this.name as keyof typeof icons] ?? icons.dashboard; }
}
