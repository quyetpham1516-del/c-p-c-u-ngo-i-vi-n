'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Training').then((m) => m.Training), { ssr: false });
