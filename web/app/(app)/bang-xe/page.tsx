'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Board').then((m) => m.Board), { ssr: false });
