'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../../src/screens/SlipPrint').then((m) => m.SlipPrint), { ssr: false });
