
import React from 'react';
import { PhotoGroup, SelectionState } from '../types';
import { formatSize } from '../utils/fileHelpers';

interface DetailOverlayProps {
  group: PhotoGroup;
  onClose: () => void;
  onToggleSelection: (state: SelectionState) => void;
}

const DetailOverlay: React.FC<DetailOverlayProps> = ({ group, onClose, onToggleSelection }) => {
  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col md:flex-row animate-in fade-in duration-300">
      {/* Main Image Area */}
      <div className="flex-1 relative flex items-center justify-center p-4">
        <button 
          onClick={onClose}
          className="absolute top-6 left-6 z-10 w-10 h-10 rounded-full bg-zinc-800/80 hover:bg-zinc-700 text-white flex items-center justify-center transition-colors"
        >
          <i className="fa-solid fa-arrow-left"></i>
        </button>
        
        <img 
          src={group.jpg?.previewUrl || group.raw?.previewUrl} 
          className="max-w-full max-h-full object-contain rounded shadow-2xl"
          alt={group.id}
        />

        {/* Floating Controls */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex gap-4 bg-zinc-900/80 backdrop-blur-md p-2 rounded-2xl border border-zinc-700 shadow-xl">
          <button 
            onClick={() => onToggleSelection(SelectionState.PICKED)}
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${group.selection === SelectionState.PICKED ? 'bg-emerald-600 text-white' : 'hover:bg-zinc-800 text-zinc-400'}`}
          >
            <i className="fa-solid fa-flag text-lg"></i>
          </button>
          <button 
            onClick={() => onToggleSelection(SelectionState.UNMARKED)}
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${group.selection === SelectionState.UNMARKED ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800 text-zinc-400'}`}
          >
            <i className="fa-solid fa-circle-dot text-lg"></i>
          </button>
          <button 
            onClick={() => onToggleSelection(SelectionState.REJECTED)}
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${group.selection === SelectionState.REJECTED ? 'bg-rose-600 text-white' : 'hover:bg-zinc-800 text-zinc-400'}`}
          >
            <i className="fa-solid fa-trash-can text-lg"></i>
          </button>
        </div>
      </div>

      {/* Info Sidebar */}
      <div className="w-full md:w-80 bg-zinc-900 border-l border-zinc-800 p-6 flex flex-col gap-6 overflow-y-auto">
        <div>
          <h2 className="text-xl font-bold mb-1 text-white">{group.id}</h2>
          <p className="text-xs text-zinc-500 uppercase tracking-widest">{group.status.replace('_', ' ')}</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <ExifItem label="Shutter" value={group.exif?.shutterSpeed} icon="fa-stopwatch" />
          <ExifItem label="Aperture" value={group.exif?.aperture} icon="fa-circle-dot" />
          <ExifItem label="ISO" value={group.exif?.iso} icon="fa-camera" />
          <ExifItem label="Focal" value={group.exif?.focalLength} icon="fa-arrows-left-right" />
        </div>

        <div className="space-y-4 pt-4 border-t border-zinc-800">
          <div>
            <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Camera</p>
            <p className="text-sm text-zinc-300">{group.exif?.model}</p>
          </div>
          <div>
            <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Lens</p>
            <p className="text-sm text-zinc-300">{group.exif?.lens}</p>
          </div>
          <div>
            <p className="text-[10px] text-zinc-500 uppercase font-bold mb-1">Captured</p>
            <p className="text-sm text-zinc-300">{group.exif?.dateTime}</p>
          </div>
        </div>

        <div className="pt-4 border-t border-zinc-800 space-y-2">
           <p className="text-[10px] text-zinc-500 uppercase font-bold mb-2">Files</p>
           {group.jpg && (
             <div className="flex justify-between items-center text-xs bg-zinc-800/50 p-2 rounded">
               <span className="text-zinc-400">JPG</span>
               <span className="text-zinc-500">{formatSize(group.jpg.size)}</span>
             </div>
           )}
           {group.raw && (
             <div className="flex justify-between items-center text-xs bg-zinc-800/50 p-2 rounded">
               <span className="text-zinc-400">{group.raw.extension} (RAW)</span>
               <span className="text-zinc-500">{formatSize(group.raw.size)}</span>
             </div>
           )}
        </div>

        <div className="mt-auto text-[10px] text-zinc-600 italic">
          Tip: Use [P] for Pick, [X] for Reject, [U] for Unmark
        </div>
      </div>
    </div>
  );
};

const ExifItem = ({ label, value, icon }: { label: string, value?: string, icon: string }) => (
  <div className="bg-zinc-800/50 p-3 rounded-lg border border-zinc-700/50">
    <div className="flex items-center gap-2 mb-1">
      <i className={`fa-solid ${icon} text-[10px] text-cyan-300`}></i>
      <span className="text-[10px] text-zinc-500 uppercase font-bold">{label}</span>
    </div>
    <span className="text-sm text-zinc-200 font-medium">{value || '--'}</span>
  </div>
);

export default DetailOverlay;
