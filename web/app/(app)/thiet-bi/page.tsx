'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Equipment').then((m) => m.Equipment), { ssr: false });
