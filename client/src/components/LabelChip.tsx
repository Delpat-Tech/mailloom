import React from 'react';
import { LABEL_CHIP, LABEL_DOT, colourOf, type Label } from '../services/labels.js';

/** A label tag with the slanted point, as in the design. */
export const LabelChip: React.FC<{ label: Pick<Label, 'name' | 'colour'> }> = ({ label }) => (
  <span
    className={`inline-flex items-center gap-[5px] h-5 pl-1.5 pr-[11px] text-[11.5px] font-bold whitespace-nowrap ${
      LABEL_CHIP[colourOf(label)]
    }`}
    style={{ clipPath: 'polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%)' }}
  >
    <i className={`w-1 h-1 rounded-full not-italic ${LABEL_DOT[colourOf(label)]}`} aria-hidden="true" />
    {label.name}
  </span>
);

/** The little tag shape shown beside a label in the rail and menus. */
export const TagSwatch: React.FC<{ colour: string }> = ({ colour }) => (
  <span
    aria-hidden="true"
    className={`w-3.5 h-2.5 shrink-0 ${LABEL_DOT[colourOf({ colour })]}`}
    style={{ clipPath: 'polygon(0 0, 70% 0, 100% 50%, 70% 100%, 0 100%)' }}
  />
);
