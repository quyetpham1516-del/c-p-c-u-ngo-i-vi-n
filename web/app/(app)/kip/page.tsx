'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Crew').then((m) => m.Crew), { ssr: false });
