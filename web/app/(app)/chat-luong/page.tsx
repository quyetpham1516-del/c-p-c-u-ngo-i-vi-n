'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Quality').then((m) => m.Quality), { ssr: false });
