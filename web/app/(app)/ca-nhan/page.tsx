'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Personal').then((m) => m.Personal), { ssr: false });
